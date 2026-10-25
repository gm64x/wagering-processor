import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { PendingReferenceWorker } from '../../src/application/pending-reference.worker';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { buildTx, createWallet, getJson, submit, toSqsData, type WalletRef } from '../support/api';
import { killAllInstances, pumpConsumer, spawnInstance, startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, q, walletBalance } from '../support/db';
import { createTestQueues, queueTotal, sendWager, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait';

let queues: TestQueues;
let server: InProcessApp;
let worker: PendingReferenceWorker;
let consumer: WagerTransactionConsumer;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 3 });
  server = await startInProcessApp({
    ...queues.env,
    PENDING_REF_MAX_ATTEMPTS: '3',
    PENDING_REF_BASE_DELAY_MS: '30',
  });
  worker = server.app.get(PendingReferenceWorker);
  consumer = server.app.get(WagerTransactionConsumer);
});
afterEach(async () => {
  await killAllInstances();
});
afterAll(async () => {
  await server.close();
  await queues.cleanup();
  await closeDb();
});

const txStatus = async (id: string) => (await q<{ status: string; failure_code: string | null; ref: string | null; attempts: number }>(
  'SELECT status, failure_code, reference_transaction_id::text AS ref, attempts FROM wager_transactions WHERE id = ?', [id]))[0]!;

/** Roda o pending-reference worker (o caminho de código real) até `done()` ser verdadeiro. */
async function runWorkerUntil(done: () => Promise<boolean>, label: string): Promise<void> {
  await waitFor(
    async () => {
      await worker.runOnce();
      return done();
    },
    20_000,
    label,
    50,
  );
}

const eventTypes = async (txId: string): Promise<string[]> =>
  (
    await q<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, id`,
      [txId],
    )
  ).map((r) => r.event_type);

describe('operação dependente entregue antes da sua referência', () => {
  for (const kind of ['ROLLBACK', 'REFUND'] as const) {
    it(`C7: ${kind} antes da BET -> 202 PENDING_REFERENCE; quando a BET chega, o worker liquida e restaura o saldo`, async () => {
      const w = await createWallet(server.baseUrl, '100.00');
      const betExternal = `bet-${crypto.randomUUID()}`;
      const dependent = buildTx(w, kind, '30.00', { referenceExternalTransactionId: betExternal });
      const roundId = dependent.roundId;

      const first = await submit(server.baseUrl, dependent);
      expect(first.status).toBe(202);
      expect(first.body.status).toBe('PENDING_REFERENCE');
      expect(first.body.balance.amount).toBe('100.00');
      const depId = first.body.transactionId as string;
      expect(await walletBalance(w.id)).toBe('100.00'); // nada se moveu ainda
      expect(await ledgerCount(w.id)).toBe(1); // só o crédito de abertura

      // um replay imediato continua "aceito, pendente"
      const replay = await submit(server.baseUrl, dependent);
      expect(replay.status).toBe(202);
      expect(replay.body.idempotentReplay).toBe(true);

      // a referência chega
      const bet = buildTx(w, 'BET', '30.00', { externalTransactionId: betExternal, roundId });
      const betRes = await submit(server.baseUrl, bet);
      expect(betRes.status).toBe(201);
      expect(await walletBalance(w.id)).toBe('70.00');

      await runWorkerUntil(async () => (await txStatus(depId)).status === 'PROCESSED', `${kind} to be settled`);
      const settled = await txStatus(depId);
      expect(settled.status).toBe('PROCESSED');
      expect(settled.ref).toBe(betRes.body.transactionId);
      expect(await walletBalance(w.id)).toBe('100.00');
      expect(await ledgerCount(w.id)).toBe(3); // crédito de abertura, débito da bet, crédito da reversão
      expect(await ledgerCount(w.id, 'CREDIT')).toBe(2);
      // eventos: o pending foi anunciado uma vez, depois a liquidação
      expect(await eventTypes(depId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);

      // reenviar a requisição original agora devolve o estado final, não uma segunda reversão
      const after = await submit(server.baseUrl, dependent);
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({ transactionId: depId, status: 'PROCESSED', idempotentReplay: true });
      expect(await ledgerCount(w.id)).toBe(3);

      // uma segunda reversão da mesma bet é recusada (regra de reversão única)
      const again = await submit(server.baseUrl, buildTx(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExternal, roundId }));
      expect(again.status).toBe(422);
      expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(await walletBalance(w.id)).toBe('100.00');
      await assertWalletConsistent(w.id);
    });
  }

  it('C7: uma referência que nunca chega termina em REJECTED / REFERENCE_NOT_FOUND após PENDING_REF_MAX_ATTEMPTS, com evento Rejected e nenhum dinheiro movido', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const dep = buildTx(w, 'ROLLBACK', '10.00', { referenceExternalTransactionId: `ghost-${crypto.randomUUID()}` });
    const res = await submit(server.baseUrl, dep);
    expect(res.status).toBe(202);
    const id = res.body.transactionId as string;

    await runWorkerUntil(async () => (await txStatus(id)).status === 'REJECTED', 'attempts to be exhausted');
    const row = await txStatus(id);
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(row.attempts).toBe(3);
    expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await walletBalance(w.id)).toBe('100.00');
    expect(await ledgerCount(w.id)).toBe(1);

    const view = await getJson(`${server.baseUrl}/wagering/transactions/${id}`);
    expect(view.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    const replay = await submit(server.baseUrl, dep);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ idempotentReplay: true, status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    // o worker não tem mais nada a fazer
    expect(await worker.runOnce()).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('C7: uma BET atrasada chegando DEPOIS da rejeição não ressuscita a reversão', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const betExternal = `late-${crypto.randomUUID()}`;
    const dep = buildTx(w, 'REFUND', '10.00', { referenceExternalTransactionId: betExternal });
    const id = (await submit(server.baseUrl, dep)).body.transactionId as string;
    await runWorkerUntil(async () => (await txStatus(id)).status === 'REJECTED', 'rejection');
    expect((await submit(server.baseUrl, buildTx(w, 'BET', '10.00', { externalTransactionId: betExternal, roundId: dep.roundId }))).status).toBe(201);
    expect(await worker.runOnce()).toBe(0);
    expect((await txStatus(id)).status).toBe('REJECTED');
    expect(await walletBalance(w.id)).toBe('90.00');
    await assertWalletConsistent(w.id);
  });

  it('C7 via SQS: mensagem ROLLBACK à frente da mensagem da BET no mesmo grupo -> pending, depois liquidada', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const rollback = buildTx(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: betExternal });
    const bet = buildTx(w, 'BET', '40.00', { externalTransactionId: betExternal, roundId: rollback.roundId });
    await sendWager(queues.mainUrl, toSqsData(rollback));
    await sendWager(queues.mainUrl, toSqsData(bet));
    await pumpConsumer(consumer, queues.mainUrl, queueTotal);

    const rbId = (await q<{ id: string }>('SELECT id::text FROM wager_transactions WHERE idempotency_key = ?', [rollback.idempotencyKey]))[0]!.id;
    expect((await txStatus(rbId)).status).toBe('PENDING_REFERENCE');
    expect(await walletBalance(w.id)).toBe('60.00');
    await runWorkerUntil(async () => (await txStatus(rbId)).status === 'PROCESSED', 'rollback settled');
    expect(await walletBalance(w.id)).toBe('100.00');
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('C7 corrida: ROLLBACK e sua BET enviados no mesmo instante, 12 wallets em paralelo -> sempre termina restaurado', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const w = await createWallet(server.baseUrl, '100.00');
        const betExternal = `bet-${crypto.randomUUID()}`;
        const rb = buildTx(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: betExternal });
        const bet = buildTx(w, 'BET', '25.00', { externalTransactionId: betExternal, roundId: rb.roundId });
        const [a, b] = await Promise.all([submit(server.baseUrl, rb), submit(server.baseUrl, bet)]);
        return { w, rb: a, bet: b };
      }),
    );
    for (const { bet } of jobs) expect(bet.status).toBe(201);
    await runWorkerUntil(
      async () =>
        (await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) AND status = 'PENDING_REFERENCE'`, [
          `{${jobs.map((j) => j.w.id).join(',')}}`,
        ])) === 0,
      'all pending references settled',
    );
    for (const { w, rb } of jobs) {
      expect([201, 202]).toContain(rb.status);
      expect(await walletBalance(w.id)).toBe('100.00');
      expect((await txStatus(rb.body.transactionId)).status).toBe('PROCESSED');
      await assertWalletConsistent(w.id);
    }
  });

  it('C7 com o loop real do worker em segundo plano, em um processo separado (sem runOnce manual)', async () => {
    const inst = await spawnInstance(
      { ...queues.env, WORKERS_ENABLED: 'true', PENDING_REF_POLL_MS: '100', PENDING_REF_BASE_DELAY_MS: '100' },
      { name: 'pendingloop' },
    );
    const w: WalletRef = await createWallet(inst.url, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const rf = buildTx(w, 'REFUND', '15.00', { referenceExternalTransactionId: betExternal });
    const r1 = await submit(inst.url, rf);
    expect(r1.status).toBe(202);
    expect((await submit(inst.url, buildTx(w, 'BET', '15.00', { externalTransactionId: betExternal, roundId: rf.roundId }))).status).toBe(201);
    await waitFor(async () => (await txStatus(r1.body.transactionId)).status === 'PROCESSED', 20_000, 'background worker to settle the refund');
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  });
});
