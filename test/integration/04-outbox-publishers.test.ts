import '../support/env';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EVENT_PUBLISHER, type EventPublisher } from '../../src/application/ports';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { buildTx, createWallet, submit, type WalletRef } from '../support/api';
import { startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, pgArray, q, unpublishedOutbox } from '../support/db';
import { createTestQueues, drainMessages, parseEvents, type TestQueues } from '../support/sqs';
import { sleep, waitFor } from '../support/wait';

let queues: TestQueues;
let appA: InProcessApp;
let appB: InProcessApp;

beforeAll(async () => {
  queues = await createTestQueues();
  appA = await startInProcessApp(queues.env);
  appB = await startInProcessApp(queues.env);
});
afterAll(async () => {
  await appA.close();
  await appB.close();
  await queues.cleanup();
  await closeDb();
});

/** Conta as chamadas de publish() por event id no SqsEventPublisher REAL (continua enviando para o SQS real). */
function spy(app: InProcessApp, calls: Map<string, number>, failFirstFor?: Set<string>): void {
  const publisher = app.app.get<EventPublisher>(EVENT_PUBLISHER);
  const original = publisher.publish.bind(publisher);
  const failed = new Set<string>();
  publisher.publish = async (message) => {
    calls.set(message.id, (calls.get(message.id) ?? 0) + 1);
    if (failFirstFor?.has(message.id) && !failed.has(message.id)) {
      failed.add(message.id);
      throw new Error('injected SQS publish failure');
    }
    return original(message);
  };
}

async function seed(n: number, bets: number): Promise<WalletRef[]> {
  const wallets: WalletRef[] = [];
  for (let i = 0; i < n; i++) wallets.push(await createWallet(appA.baseUrl, '1000.00'));
  await Promise.all(
    wallets.flatMap((w) => Array.from({ length: bets }, () => submit(appA.baseUrl, buildTx(w, 'BET', '10.00')))),
  );
  return wallets;
}

describe('publishers concorrentes do outbox', () => {
  it('dois publishers drenando um outbox publicam cada evento exatamente uma vez e marcam todos como publicados', async () => {
    const wallets = await seed(10, 5);
    const ids = wallets.map((w) => w.id);
    const rows = await q<{ id: string; event_type: string }>(
      `SELECT id::text, event_type FROM outbox_messages WHERE aggregate_id = ANY(?::text[])`,
      [pgArray(ids)],
    );
    // 10 wallets x (OPENING: Processed + BalanceChanged  +  5 bets x (Processed + BalanceChanged))
    expect(rows.length).toBe(10 * 2 * 6);
    expect(await unpublishedOutbox(ids)).toBe(rows.length);

    const calls = new Map<string, number>();
    spy(appA, calls);
    spy(appB, calls);
    const pubA = appA.app.get(OutboxPublisher);
    const pubB = appB.app.get(OutboxPublisher);

    const run = async (p: OutboxPublisher): Promise<number> => {
      let total = 0;
      const deadline = Date.now() + 60_000;
      while ((await unpublishedOutbox(ids)) > 0 && Date.now() < deadline) total += await p.publishBatch();
      return total;
    };
    const [fromA, fromB] = await Promise.all([run(pubA), run(pubB)]);
    expect(await unpublishedOutbox(ids)).toBe(0);
    expect(fromA + fromB).toBeGreaterThanOrEqual(rows.length);

    // publish() foi chamado uma vez por evento nos DOIS publishers (SKIP LOCKED + published_at na mesma transação)
    for (const r of rows) expect(calls.get(r.id), `chamadas de publish para ${r.id}`).toBe(1);
    expect(
      await count(`SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ANY(?::text[]) AND published_at IS NULL`, [pgArray(ids)]),
    ).toBe(0);

    // ...e a fila de eventos tem cada eventId uma vez
    const wanted = new Set(rows.map((r) => r.id));
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 40_000,
      isDone: (all) => parseEvents(all).filter((e) => wanted.has(e.eventId)).length >= wanted.size,
    });
    const mine = parseEvents(msgs).filter((e) => wanted.has(e.eventId));
    expect(mine.length).toBe(rows.length);
    expect(new Set(mine.map((e) => e.eventId)).size).toBe(rows.length);

    // cada wallet recebeu seus eventos em ordem (grupo FIFO = wallet): as versões crescem estritamente
    for (const w of wallets) {
      const versions = mine.filter((e) => e.aggregateId === w.id && e.eventType === 'WalletBalanceChanged').map((e) => e.data.walletVersion as number);
      expect(versions.length).toBe(6);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      await assertWalletConsistent(w.id);
    }
    // os dois publishers participaram (não é garantido, mas com 120 linhas e lotes de 50 é o normal)
    expect(fromA + fromB).toBeGreaterThanOrEqual(120);
  });

  it('um publish que falha é reenviado depois com backoff, não perde o evento e mantém a ordem por wallet', async () => {
    const [w, other] = await seed(2, 3);
    const ids = [w!.id, other!.id];
    const ordered = await q<{ id: string; event_type: string }>(
      `SELECT id::text, event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`,
      [w!.id],
    );
    const first = ordered[0]!.id;
    const calls = new Map<string, number>();
    spy(appA, calls, new Set([first])); // o primeiro evento de `w` falha uma vez
    spy(appB, calls);
    const pubA = appA.app.get(OutboxPublisher);

    // (o outbox pode ter linhas antigas de outros testes; continua publicando até a falha acontecer e `other` sair)
    await waitFor(
      async () => {
        await pubA.publishBatch();
        return (await unpublishedOutbox([other!.id])) === 0 && (await count('SELECT attempts FROM outbox_messages WHERE id = ?', [first])) >= 1;
      },
      30_000,
      'first event of w to fail once while the other wallet is published',
      50,
    );
    const [row] = await q<{ attempts: number; last_error: string | null; published_at: string | null; delay: number }>(
      `SELECT attempts, last_error, published_at, EXTRACT(EPOCH FROM (next_attempt_at - now())) AS delay FROM outbox_messages WHERE id = ?`,
      [first],
    );
    expect(row!.published_at).toBeNull();
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain('injected SQS publish failure');
    expect(Number(row!.delay)).toBeGreaterThan(0); // backoff agendado para o futuro
    // os eventos seguintes da mesma wallet NÃO podem ultrapassar o que falhou
    const publishedOfW = await count(`SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NOT NULL`, [w!.id]);
    expect(publishedOfW).toBe(0);
    // a outra wallet não foi bloqueada por ele (verificado no wait acima)

    // drena com os dois publishers até tudo sair
    await waitFor(
      async () => {
        await Promise.all([pubA.publishBatch(), appB.app.get(OutboxPublisher).publishBatch()]);
        return (await unpublishedOutbox(ids)) === 0;
      },
      30_000,
      'failed event to be retried and published',
      300,
    );
    expect(calls.get(first)).toBe(2);

    const wanted = new Set(
      (await q<{ id: string }>(`SELECT id::text FROM outbox_messages WHERE aggregate_id = ANY(?::text[])`, [pgArray(ids)])).map((r) => r.id),
    );
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 30_000,
      isDone: (all) => parseEvents(all).filter((e) => wanted.has(e.eventId)).length >= wanted.size,
    });
    const events = parseEvents(msgs).filter((e) => e.aggregateId === w!.id);
    expect(events.map((e) => e.eventId)).toEqual(ordered.map((r) => r.id)); // ordem original exata, nada perdido ou duplicado
    await sleep(0);
    for (const x of [w!, other!]) await assertWalletConsistent(x.id);
  });
});
