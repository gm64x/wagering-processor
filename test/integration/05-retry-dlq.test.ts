import '../support/env';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { buildTx, createWallet, toSqsData } from '../support/api';
import { killAllInstances, pumpConsumer, spawnInstance, startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, q, walletBalance } from '../support/db';
import { DATABASE_URL } from '../support/env';
import { startTcpProxy, type TcpProxy } from '../support/proxy';
import { createTestQueues, drainMessages, queueTotal, sendRaw, sendWager, wagerEnvelope, type TestQueues } from '../support/sqs';
import { sleep, waitFor } from '../support/wait';

let queues: TestQueues;
let server: InProcessApp;
let consumer: WagerTransactionConsumer;
let proxy: TcpProxy | undefined;

beforeAll(async () => {
  // SQS_MAX_RECEIVES=2 (limite do próprio app), redrive nativo bem acima dele para testar só a lógica do app
  queues = await createTestQueues({ visibilityTimeout: 2, maxReceives: 2, redriveMaxReceiveCount: 10 });
  server = await startInProcessApp(queues.env);
  consumer = server.app.get(WagerTransactionConsumer);
});
afterEach(async () => {
  await killAllInstances();
  await proxy?.close();
  proxy = undefined;
});
afterAll(async () => {
  await server.close();
  await queues.cleanup();
  await closeDb();
});

const pump = () => pumpConsumer(consumer, queues.mainUrl, queueTotal);

describe('retry e DLQ', () => {
  it('(a) erros permanentes vão direto para a DLQ com um motivo e saem da fila principal', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const good = buildTx(w, 'BET', '10.00');
    const ghost = buildTx({ id: randomUUID(), playerId: randomUUID(), currency: 'BRL' }, 'BET', '10.00');
    const cases: Array<{ name: string; body: string; reason: string }> = [
      { name: 'malformed JSON', body: '{"messageId": "x", "type":', reason: 'VALIDATION_ERROR' },
      { name: 'not an object', body: '"just a string"', reason: 'VALIDATION_ERROR' },
      { name: 'unknown message type', body: JSON.stringify({ messageId: randomUUID(), type: 'Nope', occurredAt: new Date().toISOString(), data: {} }), reason: 'VALIDATION_ERROR' },
      { name: 'invalid kind', body: wagerEnvelope({ ...toSqsData(good), kind: 'TELEPORT' }), reason: 'VALIDATION_ERROR' },
      { name: 'invalid amount', body: wagerEnvelope({ ...toSqsData(good), money: { amount: '1e5', currency: 'BRL' } }), reason: 'VALIDATION_ERROR' },
      { name: 'unknown wallet', body: wagerEnvelope(toSqsData(ghost)), reason: 'WALLET_NOT_FOUND' },
    ];
    for (const c of cases) await sendRaw(queues.mainUrl, c.body, randomUUID());
    await pump();
    expect(await queueTotal(queues.mainUrl)).toBe(0);

    const msgs = await drainMessages(queues.dlqUrl, { isDone: (all) => all.length >= cases.length, timeoutMs: 20_000 });
    expect(msgs.length).toBe(cases.length);
    for (const c of cases) {
      const m = msgs.find((x) => x.Body === c.body);
      expect(m, `${c.name} chegou à DLQ com o body original`).toBeDefined();
      expect(m!.MessageAttributes?.reason?.StringValue, c.name).toBe(c.reason);
    }
    // nenhuma delas teve efeito
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  });

  it('(b) falha transitória: o banco está fora -> retry com backoff de visibilidade, depois DLQ após SQS_MAX_RECEIVES', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    proxy = await startTcpProxy();
    const url = new URL(DATABASE_URL);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    const child = await spawnInstance(
      { ...queues.env, DATABASE_URL: url.toString(), WORKERS_ENABLED: 'true', SQS_MAX_RECEIVES: '2' },
      { name: 'dbdown' },
    );
    proxy.cut(); // o banco do consumer agora está inacessível

    const req = buildTx(w, 'BET', '10.00');
    const messageId = `msg-${randomUUID()}`;
    const startedAt = Date.now();
    await sendWager(queues.mainUrl, toSqsData(req), messageId);

    const dlq = await drainMessages(queues.dlqUrl, { isDone: (all) => all.length >= 1, timeoutMs: 40_000 });
    expect(dlq.length).toBe(1);
    expect(dlq[0]!.MessageAttributes?.reason?.StringValue).toBe('MAX_RECEIVES_EXCEEDED');
    expect(JSON.parse(dlq[0]!.Body!).messageId).toBe(messageId);
    // a segunda recepção só acontece após o backoff de visibilidade (>= ~1s aqui): a mensagem foi de fato reenviada, não descartada de imediato
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    await waitFor(async () => (await queueTotal(queues.mainUrl)) === 0, 15_000, 'main queue empty');

    const log = await child.readLog();
    expect(log).toContain('transient failure; message will be retried');
    expect(log).toContain('MAX_RECEIVES_EXCEEDED');

    // nada foi aplicado
    proxy.restore();
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM inbox_messages WHERE message_id = ?', [messageId])).toBe(0);
    expect(await walletBalance(w.id)).toBe('100.00');
    await assertWalletConsistent(w.id);
  });

  it('(b2) falha transitória que se recupera antes do limite: reenviada, depois aplicada exatamente uma vez e com ack', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    proxy = await startTcpProxy();
    const url = new URL(DATABASE_URL);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    const child = await spawnInstance(
      { ...queues.env, DATABASE_URL: url.toString(), WORKERS_ENABLED: 'true', SQS_MAX_RECEIVES: '6', SQS_VISIBILITY_BACKOFF_MAX_S: '2' },
      { name: 'dbflap' },
    );
    proxy.cut();
    const req = buildTx(w, 'BET', '10.00');
    await sendWager(queues.mainUrl, toSqsData(req));
    await waitFor(async () => (await child.readLog()).includes('transient failure; message will be retried'), 20_000, 'first retry log');
    proxy.restore();

    await waitFor(
      async () => (await count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [req.idempotencyKey])) === 1,
      30_000,
      'message applied after the database came back',
    );
    await waitFor(async () => (await queueTotal(queues.mainUrl)) === 0, 20_000, 'message acked');
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('(c) rejeição de negócio (saldo insuficiente) recebe ack: sem retry, fora da DLQ, registrada como REJECTED', async () => {
    const w = await createWallet(server.baseUrl, '10.00');
    const req = buildTx(w, 'BET', '50.00');
    await sendWager(queues.mainUrl, toSqsData(req));
    expect(await pump()).toBe(1); // recebida exatamente uma vez

    const [tx] = await q<{ status: string; failure_code: string; id: string }>(
      'SELECT id::text, status, failure_code FROM wager_transactions WHERE idempotency_key = ?',
      [req.idempotencyKey],
    );
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(
      await count(`SELECT COUNT(*) FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'transactionId' = ?`, [tx!.id]),
    ).toBe(1);

    // espera o visibility timeout (2s): uma mensagem que NÃO foi apagada voltaria agora
    await sleep(2500);
    expect(await consumer.pollOnce()).toBe(0);
    expect(await queueTotal(queues.mainUrl)).toBe(0);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    expect(await walletBalance(w.id)).toBe('10.00');
    await assertWalletConsistent(w.id);
  });
});
