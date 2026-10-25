import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, getWallet, toSqsData } from '../support/api';
import { killAllInstances, spawnInstance, startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, q, unpublishedOutbox, walletBalance } from '../support/db';
import { createTestQueues, queueCounts, queueTotal, sendWager, waitQueueEmpty, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait';

let queues: TestQueues;
let server: InProcessApp;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 3 });
  server = await startInProcessApp(queues.env);
});
afterEach(async () => {
  await killAllInstances();
});
afterAll(async () => {
  await server.close();
  await queues.cleanup();
  await closeDb();
});

describe('worker morto após o commit e antes do ack', () => {
  it('C5: o processo morre (exit 137) após o commit; a mensagem é reenviada, deduplicada pela inbox e por fim apagada', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '30.00');
    const messageId = `msg-crash-after-commit-${crypto.randomUUID()}`;

    const victim = await spawnInstance(
      { ...queues.env, WORKERS_ENABLED: 'true', FAULT_CRASH_AFTER_COMMIT: '1' },
      { name: 'victim' },
    );
    await sendWager(queues.mainUrl, toSqsData(req), messageId);

    // o processo sai sozinho, com o código injetado, depois de commitar
    const code = await Promise.race([
      victim.exited,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('victim did not crash within 30s')), 30_000)),
    ]);
    expect(code).toBe(137);
    expect(await victim.readLog()).toContain('FAULT_CRASH_AFTER_COMMIT');

    // o efeito ESTÁ commitado...
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM inbox_messages WHERE message_id = ?', [messageId])).toBe(1);
    expect(await walletBalance(w.id)).toBe('70.00');
    // ...mas a mensagem nunca recebeu ack: ela continua na fila (em voo até o visibility timeout expirar)
    expect(await queueTotal(queues.mainUrl)).toBe(1);
    expect((await queueCounts(queues.mainUrl)).inFlight + (await queueCounts(queues.mainUrl)).visible).toBe(1);
    // e as linhas do outbox commitadas junto continuam pendentes (o processo morto nunca as publicou)
    expect(await unpublishedOutbox([w.id])).toBeGreaterThan(0);

    // uma instância saudável pega a mensagem depois do visibility timeout
    await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true' }, { name: 'survivor' });
    await waitQueueEmpty(queues.mainUrl, 30_000);
    await waitFor(async () => (await unpublishedOutbox([w.id])) === 0, 30_000, 'survivor to publish the outbox');

    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM inbox_messages WHERE message_id = ?', [messageId])).toBe(1);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('70.00');
    expect((await getWallet(server.baseUrl, w.id)).balance.amount).toBe('70.00');
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    // cada evento de negócio existe uma vez
    const tx = (await q<{ id: string }>('SELECT id::text FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey]))[0]!;
    expect(await count(`SELECT COUNT(*) FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [tx.id])).toBe(2);
    await assertWalletConsistent(w.id);
  });

  it('variante C5: o crash acontece no meio de um lote de uma wallet; tudo é aplicado exatamente uma vez', async () => {
    const w = await createWallet(server.baseUrl, '1000.00');
    const reqs = Array.from({ length: 8 }, () => buildTx(w, 'BET', '10.00'));
    for (const r of reqs) await sendWager(queues.mainUrl, toSqsData(r));

    const victim = await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true', FAULT_CRASH_AFTER_COMMIT: '1' }, { name: 'victim2' });
    expect(await victim.exited).toBe(137);
    const afterCrash = await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [w.id]);
    expect(afterCrash).toBe(1); // morreu logo após o primeiro commit

    await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true' }, { name: 'survivor2' });
    await waitFor(
      async () => (await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [w.id])) === 8,
      40_000,
      'remaining messages processed',
    );
    await waitQueueEmpty(queues.mainUrl, 40_000);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(8);
    expect(await walletBalance(w.id)).toBe('920.00');
    await assertWalletConsistent(w.id);
  });
});
