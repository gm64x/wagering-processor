import '../support/env';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, describe, expect, it } from 'bun:test';
import config from '../../src/infrastructure/persistence/mikro-orm.config';
import { closeDb, count, expectDbError, q } from '../support/db';
import { DATABASE_URL } from '../support/env';

/** SQL direto: prova que as garantias vivem no banco, e não só no código da aplicação. */

async function insertWallet(balance = '100.00', currency = 'BRL', playerId = randomUUID()): Promise<string> {
  const id = randomUUID();
  await q('INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, ?, ?, 1)', [
    id,
    playerId,
    currency,
    balance,
  ]);
  return id;
}

interface TxOpts {
  kind?: string;
  status?: string;
  amount?: string;
  key?: string;
  ref?: string | null;
  refId?: string | null;
  external?: string;
  provider?: string;
}

async function insertTx(walletId: string, o: TxOpts = {}): Promise<{ id: string; key: string; external: string }> {
  const id = randomUUID();
  const external = o.external ?? `ext-${randomUUID()}`;
  const key = o.key ?? `key-${randomUUID()}`;
  const status = o.status ?? 'PENDING';
  await q(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at)
     SELECT ?, ?, ?, ?, repeat('a', 64), w.id, w.player_id, 'r1', 'g1', ?, ?, w.currency, ?, ?, ?,
            CASE WHEN ? = 'PROCESSED' THEN now() ELSE NULL END
     FROM wallets w WHERE w.id = ?`,
    [
      id,
      o.provider ?? 'prov-c',
      external,
      key,
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.ref ?? null,
      o.refId ?? null,
      status,
      status,
      walletId,
    ],
  );
  return { id, key, external };
}

async function insertLedger(
  walletId: string,
  txId: string,
  o: { direction?: string; amount?: string; before?: string; after?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount, balance_after_amount)
     VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?)`,
    [id, walletId, txId, o.direction ?? 'DEBIT', o.amount ?? '10.00', o.before ?? '100.00', o.after ?? '90.00'],
  );
  return id;
}

afterAll(async () => {
  await closeDb();
});

describe('migrações e constraints do banco', () => {
  it('rejeita saldo negativo na wallet (CHECK) no insert e no update', async () => {
    await expectDbError(
      q('INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, ?, ?, 1)', [
        randomUUID(),
        randomUUID(),
        'BRL',
        '-0.01',
      ]),
      /balance_amount_check|check constraint/i,
    );
    const walletId = await insertWallet('5.00');
    await expectDbError(q('UPDATE wallets SET balance_amount = -1 WHERE id = ?', [walletId]), /check constraint/i);
    expect(await q('SELECT balance_amount::text AS b FROM wallets WHERE id = ?', [walletId])).toEqual([{ b: '5.00' }]);
  });

  it('rejeita uma segunda wallet para o mesmo (player, currency), mas permite outra moeda', async () => {
    const player = randomUUID();
    await insertWallet('1.00', 'BRL', player);
    await expectDbError(insertWallet('1.00', 'BRL', player), /uq_wallets_player_currency/);
    await insertWallet('1.00', 'USD', player); // outra moeda é outra wallet
  });

  it('torna o ledger append-only: UPDATE e DELETE são rejeitados por trigger', async () => {
    const walletId = await insertWallet('90.00');
    const tx = await insertTx(walletId, { status: 'PROCESSED' });
    const entryId = await insertLedger(walletId, tx.id);

    await expectDbError(q('UPDATE wallet_ledger_entries SET amount = 99 WHERE id = ?', [entryId]), /append-only/);
    await expectDbError(q('DELETE FROM wallet_ledger_entries WHERE id = ?', [entryId]), /append-only/);
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE id = ?', [entryId])).toBe(1);
    expect(await q('SELECT amount::text AS a FROM wallet_ledger_entries WHERE id = ?', [entryId])).toEqual([{ a: '10.00' }]);
  });

  it('rejeita linha do ledger cuja aritmética não fecha (ck_ledger_arithmetic) e valores não positivos', async () => {
    const walletId = await insertWallet('100.00');
    const tx = await insertTx(walletId, { status: 'PROCESSED' });
    await expectDbError(
      insertLedger(walletId, tx.id, { direction: 'DEBIT', amount: '10.00', before: '100.00', after: '85.00' }),
      /ck_ledger_arithmetic/,
    );
    await expectDbError(
      insertLedger(walletId, tx.id, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '90.00' }),
      /ck_ledger_arithmetic/,
    );
    await expectDbError(
      insertLedger(walletId, tx.id, { direction: 'CREDIT', amount: '0.00', before: '100.00', after: '100.00' }),
      /amount_check|check constraint/i,
    );
    expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId])).toBe(0);
  });

  it('permite apenas uma entrada de ledger por (transaction, wallet)', async () => {
    const walletId = await insertWallet('100.00');
    const tx = await insertTx(walletId, { status: 'PROCESSED' });
    await insertLedger(walletId, tx.id);
    await expectDbError(insertLedger(walletId, tx.id), /uq_ledger_tx_wallet/);
  });

  it('rejeita idempotency_key duplicada e (provider, external id) duplicado', async () => {
    const walletId = await insertWallet();
    const first = await insertTx(walletId);
    await expectDbError(insertTx(walletId, { key: first.key }), /uq_wtx_idempotency_key/);
    await expectDbError(insertTx(walletId, { external: first.external }), /uq_wtx_provider_external/);
    // mesmo external id em outro provider é outra transação
    await insertTx(walletId, { external: first.external, provider: 'prov-other' });
  });

  it('rejeita UPDATE ou DELETE de uma wager_transaction terminal (trigger), mas permite PENDING_REFERENCE -> final', async () => {
    const walletId = await insertWallet();
    const done = await insertTx(walletId, { status: 'PROCESSED' });
    await expectDbError(q(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [done.id]), /terminal/);
    await expectDbError(q(`UPDATE wager_transactions SET round_id = 'other' WHERE id = ?`, [done.id]), /terminal/);
    await expectDbError(q('DELETE FROM wager_transactions WHERE id = ?', [done.id]), /append-only/);
    expect(await q('SELECT status FROM wager_transactions WHERE id = ?', [done.id])).toEqual([{ status: 'PROCESSED' }]);

    const pending = await insertTx(walletId, { status: 'PENDING_REFERENCE', kind: 'ROLLBACK', ref: 'x' });
    // colunas imutáveis não mudam nem em linha não terminal
    await expectDbError(q(`UPDATE wager_transactions SET amount = 99 WHERE id = ?`, [pending.id]), /immutable/);
    await q(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND' WHERE id = ?`, [pending.id]);
    await expectDbError(q(`UPDATE wager_transactions SET failure_code = 'Y' WHERE id = ?`, [pending.id]), /terminal/);
  });

  it('permite uma única reversão PROCESSED por referência (uq_wtx_single_reversal)', async () => {
    const walletId = await insertWallet();
    const bet = await insertTx(walletId, { kind: 'BET', status: 'PROCESSED' });
    await insertTx(walletId, { kind: 'REFUND', status: 'PROCESSED', ref: bet.external, refId: bet.id });
    await expectDbError(
      insertTx(walletId, { kind: 'REFUND', status: 'PROCESSED', ref: bet.external, refId: bet.id }),
      /uq_wtx_single_reversal/,
    );
    // um ROLLBACK da mesma referência também é uma reversão, então também é bloqueado
    await expectDbError(
      insertTx(walletId, { kind: 'ROLLBACK', status: 'PROCESSED', ref: bet.external, refId: bet.id }),
      /uq_wtx_single_reversal/,
    );
    // uma tentativa REJECTED precisa ter código de falha
    await expectDbError(
      insertTx(walletId, { kind: 'REFUND', status: 'REJECTED', ref: bet.external, refId: bet.id }),
      /ck_wtx_rejected_has_code/,
    );
  });

  it('aplica os demais CHECKs de tabela (reversão exige referência, OPENING é interno, PK da inbox)', async () => {
    const walletId = await insertWallet();
    await expectDbError(insertTx(walletId, { kind: 'REFUND', ref: null }), /ck_wtx_reference_required/);
    await expectDbError(insertTx(walletId, { kind: 'OPENING' }), /ck_wtx_opening_internal/);
    const messageId = randomUUID();
    await q(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c', ?, repeat('b', 64))`, [messageId]);
    await expectDbError(
      q(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c', ?, repeat('b', 64))`, [messageId]),
      /inbox_messages_pkey|duplicate key/,
    );
  });

  it('migrações são reversíveis: up -> down (até zero) -> up em um banco descartável', async () => {
    const dbName = `wagering_mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const adminUrl = new URL(DATABASE_URL);
    await q(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl.toString());
    url.pathname = `/${dbName}`;
    const tables = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

    const orm = await MikroORM.init({ ...config, clientUrl: url.toString(), pool: { min: 1, max: 2 } });
    try {
      const present = async (): Promise<string[]> => {
        const rows = (await orm.em
          .fork()
          .execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)) as Array<{ table_name: string }>;
        return rows.map((r) => r.table_name);
      };
      const triggers = async (): Promise<string[]> =>
        ((await orm.em.fork().execute(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)) as Array<{ tgname: string }>).map((r) => r.tgname);
      const functions = async (): Promise<string[]> =>
        (
          (await orm.em
            .fork()
            .execute(`SELECT proname FROM pg_proc WHERE proname IN ('forbid_ledger_mutation','guard_wager_transaction_update')`)) as Array<{ proname: string }>
        ).map((r) => r.proname);

      const migrator = orm.getMigrator();
      const applied = await migrator.up();
      expect(applied.length).toBe(2);
      for (const t of tables) expect(await present()).toContain(t);
      expect(await triggers()).toEqual(expect.arrayContaining(['trg_ledger_immutable', 'trg_wtx_guard']));
      expect((await migrator.getPendingMigrations()).length).toBe(0);

      const reverted = await migrator.down({ to: 0 });
      expect(reverted.length).toBe(2);
      for (const t of tables) expect(await present()).not.toContain(t);
      expect(await functions()).toEqual([]); // funções também removidas: nada sobra
      expect((await migrator.getPendingMigrations()).length).toBe(2);

      await migrator.up();
      for (const t of tables) expect(await present()).toContain(t);
      expect(await triggers()).toEqual(expect.arrayContaining(['trg_ledger_immutable', 'trg_wtx_guard', 'trg_ledger_no_truncate']));
      expect((await migrator.getPendingMigrations()).length).toBe(0);
    } finally {
      await orm.close(true);
      await q(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    }
  });
});
