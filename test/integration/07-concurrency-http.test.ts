import '../support/env';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, getWallet, submit, type TxRequest } from '../support/api';
import { startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, q, walletBalance } from '../support/db';

let server: InProcessApp;

beforeAll(async () => {
  server = await startInProcessApp();
});
afterAll(async () => {
  await server.close();
  await closeDb();
});

describe('concorrência (requisições HTTP paralelas reais)', () => {
  it('C1: a mesma BET enviada 50 vezes em paralelo gera um débito e 49 replays da mesma transação', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '30.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(server.baseUrl, req)));

    const created = results.filter((r) => r.status === 201);
    const replays = results.filter((r) => r.status === 200);
    expect(created.length).toBe(1);
    expect(replays.length).toBe(49);
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false).length).toBe(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(['70.00'])); // replays devolvem o resultado original

    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])).toBe(1);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(
      await count(`SELECT COUNT(*) FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [created[0]!.body.transactionId]),
    ).toBe(2); // exatamente um Processed + um BalanceChanged, e não 50
    await assertWalletConsistent(w.id);
  });

  async function raceTwoBets(): Promise<{ w: Awaited<ReturnType<typeof createWallet>>; a: TxRequest; b: TxRequest; ra: any; rb: any }> {
    const w = await createWallet(server.baseUrl, '100.00');
    const a = buildTx(w, 'BET', '80.00');
    const b = buildTx(w, 'BET', '80.00');
    const [ra, rb] = await Promise.all([submit(server.baseUrl, a), submit(server.baseUrl, b)]);
    return { w, a, b, ra, rb };
  }

  it('C2 (spec, seção 8): saldo 100.00, duas BETs concorrentes de 80.00 -> uma PROCESSED, uma REJECTED, 20.00, um débito; retries não somam nada', async () => {
    const { w, a, b, ra, rb } = await raceTwoBets();
    const statuses = [ra.body.status, rb.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const [ok, ko] = ra.body.status === 'PROCESSED' ? [ra, rb] : [rb, ra];
    expect(ok.status).toBe(201);
    expect(ko.status).toBe(422);
    expect(ko.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect((await getWallet(server.baseUrl, w.id)).balance.amount).toBe('20.00');

    // reenvia as duas requisições: mesmos resultados, marcados como replays, ainda um débito
    const [pa, pb] = await Promise.all([submit(server.baseUrl, a), submit(server.baseUrl, b)]);
    for (const [first, again] of [
      [ra, pa],
      [rb, pb],
    ] as const) {
      expect(again.body.idempotentReplay).toBe(true);
      expect(again.body.transactionId).toBe(first.body.transactionId);
      expect(again.body.status).toBe(first.body.status);
      expect(again.status).toBe(first.body.status === 'PROCESSED' ? 200 : 422);
    }
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = ?', [w.id, 'BET'])).toBe(2);
    await assertWalletConsistent(w.id);
  });

  it('C2 repetido: a corrida 80+80 em 25 wallets novas nunca gasta duas vezes', async () => {
    const outcomes = await Promise.all(Array.from({ length: 25 }, () => raceTwoBets()));
    for (const { w, ra, rb } of outcomes) {
      expect([ra.body.status, rb.body.status].sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(await walletBalance(w.id)).toBe('20.00');
      expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
      await assertWalletConsistent(w.id);
    }
  });

  it('wallet quente: 60 BETs distintas de 10.00 contra 250.00 -> exatamente 25 PROCESSED, 35 REJECTED, saldo 0.00', async () => {
    const w = await createWallet(server.baseUrl, '250.00');
    const results = await Promise.all(Array.from({ length: 60 }, () => submit(server.baseUrl, buildTx(w, 'BET', '10.00'))));
    expect(results.filter((r) => r.body.status === 'PROCESSED').length).toBe(25);
    const rejected = results.filter((r) => r.body.status === 'REJECTED');
    expect(rejected.length).toBe(35);
    expect(rejected.every((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await walletBalance(w.id)).toBe('0.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(25);
    // versões são contínuas: cada movimento commitado incrementou a versão exatamente uma vez (1 opening + 25 débitos)
    expect(await q('SELECT version FROM wallets WHERE id = ?', [w.id])).toEqual([{ version: 26 }]);
    await assertWalletConsistent(w.id);
  });

  it('C3: 20 wallets distintas x 10 operações mistas, todas em paralelo, continuam individualmente consistentes', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(server.baseUrl, '1000.00')));
    const work = wallets.flatMap((w) => [
      ...Array.from({ length: 6 }, () => buildTx(w, 'BET', '10.00')),
      ...Array.from({ length: 2 }, () => buildTx(w, 'WIN', '5.00')),
      ...Array.from({ length: 2 }, () => buildTx(w, 'LOSS', '0.00')),
    ]);
    // embaralha para que as requisições de wallets diferentes se intercalem
    for (let i = work.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [work[i], work[j]] = [work[j]!, work[i]!];
    }
    const results = await Promise.all(work.map((tx) => submit(server.baseUrl, tx)));
    expect(results.every((r) => r.status === 201 && r.body.status === 'PROCESSED')).toBe(true);

    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('950.00'); // 1000 - 6*10 + 2*5
      expect(await ledgerCount(w.id)).toBe(1 + 6 + 2); // opening + bets + wins (LOSS não move nada)
      expect(await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'LOSS' AND status = 'PROCESSED'`, [w.id])).toBe(2);
      await assertWalletConsistent(w.id);
    }
  });
});
