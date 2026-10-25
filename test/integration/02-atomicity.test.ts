import '../support/env';
import { randomUUID } from 'node:crypto';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { WagerEngine } from '../../src/application/wager-engine';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { WalletRepository } from '../../src/infrastructure/persistence/wallet.repository';
import { buildTx, createWallet, submit, type WalletRef } from '../support/api';
import { startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, q } from '../support/db';

let server: InProcessApp;

beforeAll(async () => {
  server = await startInProcessApp();
});
afterAll(async () => {
  await server.close();
  await closeDb();
});

const eventTypesFor = async (txId: string): Promise<string[]> =>
  (
    await q<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, id`,
      [txId],
    )
  ).map((r) => r.event_type);

const wallet = async (id: string) =>
  (await q<{ balance: string; version: number }>('SELECT balance_amount::text AS balance, version FROM wallets WHERE id = ?', [id]))[0]!;

describe('atomicidade: wallet + transação + ledger + outbox commitam juntos', () => {
  it('uma BET processada deixa exatamente uma tx, uma linha de ledger, um incremento de versão e os dois eventos de outbox', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const before = await wallet(w.id);
    expect(before.version).toBe(1);

    const req = buildTx(w, 'BET', '25.00');
    const res = await submit(server.baseUrl, req);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PROCESSED');
    const txId = res.body.transactionId as string;

    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE transaction_id = ?', [txId])).toBe(1);
    const after = await wallet(w.id);
    expect(after.balance).toBe('75.00');
    expect(after.version).toBe(before.version + 1);
    expect(await eventTypesFor(txId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const [entry] = await q<Record<string, string>>(
      `SELECT direction, amount::text AS amount, balance_before_amount::text AS b, balance_after_amount::text AS a
       FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [txId],
    );
    expect(entry).toEqual({ direction: 'DEBIT', amount: '25.00', b: '100.00', a: '75.00' });
    // o evento WalletBalanceChanged carrega a mesma versão que a linha da wallet recebeu
    const [bc] = await q<{ v: string }>(
      `SELECT payload->'data'->>'walletVersion' AS v FROM outbox_messages WHERE event_type = 'WalletBalanceChanged' AND payload->'data'->>'transactionId' = ?`,
      [txId],
    );
    expect(Number(bc!.v)).toBe(after.version);
    await assertWalletConsistent(w.id);
  });

  it('uma BET rejeitada persiste REJECTED + um evento Rejected, SEM linha de ledger e SEM mudança de versão', async () => {
    const w = await createWallet(server.baseUrl, '10.00');
    const before = await wallet(w.id);
    const ledgerBefore = await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?', [w.id]);

    const res = await submit(server.baseUrl, buildTx(w, 'BET', '50.00'));
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    const txId = res.body.transactionId as string;

    const [row] = await q<{ status: string; failure_code: string }>('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [txId]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE transaction_id = ?', [txId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?', [w.id])).toBe(ledgerBefore);
    expect(await wallet(w.id)).toEqual(before);
    expect(await eventTypesFor(txId)).toEqual(['WagerTransactionRejected']);
    await assertWalletConsistent(w.id);
  });

  /**
   * Roda o engine REAL dentro de uma transação que controlamos e faz essa transação falhar depois:
   * tudo que o engine escreveu (linha da tx, update da wallet, ledger, outbox) precisa sumir junto.
   */
  async function settleThenFail(
    w: WalletRef,
    failure: (em: EntityManager, txId: string) => Promise<void>,
  ): Promise<{ txId: string; error: Error }> {
    const orm = server.app.get(MikroORM) as MikroORM;
    const engine = server.app.get(WagerEngine);
    const wallets = server.app.get(WalletRepository);
    const txId = uuidv7();
    let error: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        const locked = await wallets.lockById(em, w.id);
        const tx = WagerTransaction.create({
          id: txId,
          providerId: 'prov-atomic',
          externalTransactionId: `ext-${randomUUID()}`,
          idempotencyKey: `key-${randomUUID()}`,
          payloadHash: 'c'.repeat(64),
          walletId: w.id,
          playerId: w.playerId,
          roundId: 'r',
          gameId: 'g',
          kind: WagerTransactionKind.Bet,
          money: Money.from({ amount: '30.00', currency: 'BRL' }),
          createdAt: new Date(),
        });
        await engine.settle(em, locked!, tx, { mode: 'insert', correlationId: randomUUID(), now: new Date() });
        // trabalho não commitado é invisível para outras conexões, mas visível para a própria transação
        expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE id = ?', [txId])).toBe(0);
        const inside = (await em.execute('SELECT balance_amount::text AS b FROM wallets WHERE id = ?', [w.id])) as Array<{ b: string }>;
        expect(inside[0]!.b).toBe('70.00');
        await failure(em, txId);
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    return { txId, error: error as Error };
  }

  async function expectNothingPersisted(w: WalletRef, txId: string): Promise<void> {
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE id = ?', [txId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE transaction_id = ?', [txId])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [txId])).toBe(0);
    expect(await wallet(w.id)).toEqual({ balance: '100.00', version: 1 });
    await assertWalletConsistent(w.id);
  }

  it('falha depois das escritas de wallet/ledger/outbox (erro de aplicação) desfaz tudo', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const { txId, error } = await settleThenFail(w, async () => {
      throw new Error('boom after wallet update');
    });
    expect(error.message).toBe('boom after wallet update');
    await expectNothingPersisted(w, txId);
  });

  it('falha levantada por constraint do banco no fim da unidade de trabalho desfaz tudo', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const { txId, error } = await settleThenFail(w, async (em, id) => {
      // violação de CHECK de aritmética: a transação inteira aborta, incluindo as linhas de wallet/ledger/outbox já escritas
      await em.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount, balance_after_amount)
         VALUES (?, ?, ?, 'CREDIT', 1, 'BRL', 70, 99)`,
        [randomUUID(), w.id, id],
      );
    });
    expect(error.message).toMatch(/ck_ledger_arithmetic/);
    await expectNothingPersisted(w, txId);
  });

  it('falha de chave duplicada dentro do serviço (race de inbox/idempotência) deixa a wallet intacta', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '10.00');
    // mesmo provider/external id mas idempotency key diferente => conflito, nada persistido
    expect((await submit(server.baseUrl, req)).status).toBe(201);
    const clash = await submit(server.baseUrl, { ...req, idempotencyKey: `other-${randomUUID()}` });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await wallet(w.id)).toEqual({ balance: '90.00', version: 2 });
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = ?', [w.id, 'BET'])).toBe(1);
    await assertWalletConsistent(w.id);
  });
});

