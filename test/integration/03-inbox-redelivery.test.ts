import '../support/env';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { buildTx, createWallet, getWallet, submit, toSqsData } from '../support/api';
import { pumpConsumer, startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, walletBalance } from '../support/db';
import { createTestQueues, queueTotal, sendRaw, sendWager, type TestQueues } from '../support/sqs';

let queues: TestQueues;
let server: InProcessApp;
let consumer: WagerTransactionConsumer;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 2 });
  server = await startInProcessApp(queues.env);
  consumer = server.app.get(WagerTransactionConsumer);
});
afterAll(async () => {
  await server.close();
  await queues.cleanup();
  await closeDb();
});

const pump = () => pumpConsumer(consumer, queues.mainUrl, queueTotal);
const inboxRows = (messageId: string) => count(`SELECT COUNT(*) FROM inbox_messages WHERE message_id = ?`, [messageId]);
const txRows = (key: string) => count('SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = ?', [key]);

describe('inbox e redelivery', () => {
  it('a mesma mensagem SQS (mesmo messageId) entregue 3 vezes tem exatamente um efeito e uma linha na inbox', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '10.00');
    const messageId = `msg-${randomUUID()}`;
    // três entregas físicas da mesma mensagem lógica (dedup ids distintos para o FIFO não colapsá-las)
    for (let i = 0; i < 3; i++) await sendWager(queues.mainUrl, toSqsData(req), messageId);

    const received = await pump();
    expect(received).toBeGreaterThanOrEqual(3);

    expect(await inboxRows(messageId)).toBe(1);
    expect(await txRows(req.idempotencyKey)).toBe(1);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(
      await count(
        `SELECT COUNT(*) FROM outbox_messages WHERE payload->'data'->>'transactionId' =
           (SELECT id::text FROM wager_transactions WHERE idempotency_key = ?)`,
        [req.idempotencyKey],
      ),
    ).toBe(2); // Processed + WalletBalanceChanged, emitidos uma vez
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('messageIds diferentes com a mesma idempotencyKey e payload ainda têm um efeito (camada de idempotência)', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '15.00');
    const ids = [`msg-${randomUUID()}`, `msg-${randomUUID()}`, `msg-${randomUUID()}`];
    for (const id of ids) await sendWager(queues.mainUrl, toSqsData(req), id);
    await pump();

    expect(await txRows(req.idempotencyKey)).toBe(1);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    expect(await walletBalance(w.id)).toBe('85.00');
    // cada mensagem foi registrada na inbox (são mensagens diferentes), mas nenhuma gerou um segundo efeito
    for (const id of ids) expect(await inboxRows(id)).toBe(1);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('mesma idempotencyKey com payload DIFERENTE é conflito: ack (sem retry, sem DLQ), nenhum segundo efeito', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const req = buildTx(w, 'BET', '10.00');
    await sendWager(queues.mainUrl, toSqsData(req));
    await sendWager(queues.mainUrl, toSqsData({ ...req, money: { amount: '99.00', currency: 'BRL' } }));
    await pump();

    expect(await txRows(req.idempotencyKey)).toBe(1);
    expect(await walletBalance(w.id)).toBe('90.00');
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });

  it('HTTP e SQS compartilham idempotência: mensagem já aplicada via HTTP é replay, e vice-versa', async () => {
    const w = await createWallet(server.baseUrl, '100.00');
    const viaHttp = buildTx(w, 'BET', '20.00');
    expect((await submit(server.baseUrl, viaHttp)).status).toBe(201);
    await sendWager(queues.mainUrl, toSqsData(viaHttp));

    const viaSqs = buildTx(w, 'BET', '5.00');
    await sendWager(queues.mainUrl, toSqsData(viaSqs));
    await pump();
    const replay = await submit(server.baseUrl, viaSqs);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);

    expect(await ledgerCount(w.id, 'DEBIT')).toBe(2);
    expect((await getWallet(server.baseUrl, w.id)).balance.amount).toBe('75.00');
    await assertWalletConsistent(w.id);
  });

  it('a inbox faz parte da mesma transação: mensagem que falha permanentemente não deixa linha na inbox e vai para a DLQ', async () => {
    const ghostWallet = { id: randomUUID(), playerId: randomUUID(), currency: 'BRL' };
    const req = buildTx(ghostWallet, 'BET', '10.00');
    const messageId = `msg-${randomUUID()}`;
    await sendWager(queues.mainUrl, toSqsData(req), messageId);
    await pump();

    expect(await inboxRows(messageId)).toBe(0); // desfeito junto com a unidade de trabalho que falhou
    expect(await txRows(req.idempotencyKey)).toBe(0);
    expect(await queueTotal(queues.dlqUrl)).toBeGreaterThanOrEqual(1);
    expect(await queueTotal(queues.mainUrl)).toBe(0);
  });

  it('um body malformado nunca chega à inbox', async () => {
    const before = await count('SELECT COUNT(*) FROM inbox_messages');
    await sendRaw(queues.mainUrl, '{"messageId": "x", "type":', randomUUID());
    await pump();
    expect(await count('SELECT COUNT(*) FROM inbox_messages')).toBe(before);
  });
});
