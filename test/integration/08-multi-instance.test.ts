import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, submit, toSqsData, type TxRequest } from '../support/api';
import { killAllInstances, spawnInstance, startInProcessApp, type Instance } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, pgArray, q, unpublishedOutbox, walletBalance } from '../support/db';
import { createTestQueues, drainMessages, parseEvents, queueTotal, sendWagerBatch, waitQueueEmpty, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait';

let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 5 });
});
afterEach(async () => {
  await killAllInstances();
});
afterAll(async () => {
  await queues.cleanup();
  await closeDb();
});

const workerEnv = () => ({ ...queues.env, WORKERS_ENABLED: 'true', SQS_MAX_RECEIVES: '5' });

async function startFleet(n: number): Promise<Instance[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => spawnInstance(workerEnv(), { name: `fleet${i}` })));
}

describe('múltiplos processos do SO compartilhando Postgres e SQS', () => {
  it('C4: 3 processos martelam uma wallet quente por HTTP (round-robin) e SQS ao mesmo tempo: sem saldo negativo, sem efeito duplicado', async () => {
    const fleet = await startFleet(3);
    expect(new Set(fleet.map((i) => i.port)).size).toBe(3);
    const urls = fleet.map((i) => i.url);
    const hot = await createWallet(urls[0]!, '500.00');

    const HTTP_OPS = 150;
    const SQS_OPS = 150;
    const httpReqs: TxRequest[] = Array.from({ length: HTTP_OPS }, () => buildTx(hot, 'BET', '10.00'));
    const sqsReqs: TxRequest[] = Array.from({ length: SQS_OPS }, () => buildTx(hot, 'BET', '10.00'));

    // SQS: vários grupos de mensagem para a MESMA wallet, para que workers diferentes consumam em paralelo
    const sqsItems = sqsReqs.map((r, i) => ({ data: toSqsData(r), messageId: `m-${r.externalTransactionId}`, groupId: `g${i % 6}` }));
    const duplicates = sqsItems.slice(0, 30); // as mesmas mensagens lógicas entregues uma segunda vez
    const sqsSend = (async () => {
      await sendWagerBatch(queues.mainUrl, sqsItems);
      await sendWagerBatch(queues.mainUrl, duplicates);
    })();
    const httpRun = Promise.all(httpReqs.map((r, i) => submit(urls[i % 3]!, r)));
    const [httpResults] = await Promise.all([httpRun, sqsSend]);

    // lado HTTP: cada resposta é um resultado de negócio limpo (201 / 422) e traz um transaction id
    for (const r of httpResults) {
      expect([201, 422]).toContain(r.status);
      expect(r.body.transactionId).toBeTruthy();
    }
    // espera o lado SQS ser totalmente aplicado
    await waitFor(
      async () => (await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [hot.id])) === HTTP_OPS + SQS_OPS,
      60_000,
      'all 300 BETs to be recorded',
      250,
    );
    await waitQueueEmpty(queues.mainUrl, 60_000);

    // tempestade de replays via HTTP em todos os processos
    const replays = await Promise.all(httpReqs.slice(0, 60).map((r, i) => submit(urls[(i + 1) % 3]!, r)));
    for (const [i, r] of replays.entries()) {
      expect(r.body.idempotentReplay).toBe(true);
      expect(r.body.transactionId).toBe(httpResults[i]!.body.transactionId);
    }

    const processed = await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`, [hot.id]);
    const rejected = await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'REJECTED'`, [hot.id]);
    expect(processed).toBe(50); // 500.00 / 10.00
    expect(rejected).toBe(HTTP_OPS + SQS_OPS - 50);
    expect(await q(`SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND status = 'REJECTED' AND failure_code <> 'INSUFFICIENT_FUNDS' LIMIT 1`, [hot.id])).toEqual([]);
    expect(await ledgerCount(hot.id, 'DEBIT')).toBe(processed); // um débito por BET processada, nem mais
    expect(await walletBalance(hot.id)).toBe('0.00');
    // cada operação lógica virou exatamente uma transação (duplicatas e replays não criaram nada)
    expect(await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ?`, [hot.id])).toBe(1 + HTTP_OPS + SQS_OPS);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(hot.id);

    // eventos: publicados pela frota, em ordem, nada perdido, nada duplicado
    await waitFor(async () => (await unpublishedOutbox([hot.id])) === 0, 60_000, 'outbox to drain', 250);
    const dbEvents = await q<{ id: string; event_type: string }>(`SELECT id::text, event_type FROM outbox_messages WHERE aggregate_id = ?`, [hot.id]);
    const wanted = new Set(dbEvents.map((e) => e.id));
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 60_000,
      isDone: (all) => parseEvents(all).filter((e) => wanted.has(e.eventId)).length >= wanted.size,
    });
    const events = parseEvents(msgs).filter((e) => wanted.has(e.eventId));
    expect(events.length).toBe(wanted.size);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(wanted.size);
    expect(events.filter((e) => e.eventType === 'WagerTransactionProcessed').length).toBe(1 + 50);
    expect(events.filter((e) => e.eventType === 'WagerTransactionRejected').length).toBe(rejected);
    const versions = events.filter((e) => e.eventType === 'WalletBalanceChanged').map((e) => e.data.walletVersion as number);
    expect(versions.length).toBe(1 + 50);
    expect(versions).toEqual([...versions].sort((a, b) => a - b)); // ordem por wallet preservada de ponta a ponta

    const perInstance = await Promise.all(fleet.map(async (i) => ((await i.readLog()).match(/wager message processed/g) ?? []).length));
    console.log(`C4: SQS messages handled per process = ${perInstance.join(' / ')}; HTTP ops spread round-robin`);
    expect(perInstance.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(SQS_OPS);
  });

  it('C6: dois processos publishers separados drenam um backlog compartilhado do outbox: cada evento chega à fila exatamente uma vez', async () => {
    // monta um backlog sem nenhum publisher vivo (app em processo, workers desligados)
    const seeder = await startInProcessApp();
    const wallets = await Promise.all(Array.from({ length: 12 }, () => createWallet(seeder.baseUrl, '1000.00')));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(seeder.baseUrl, buildTx(w, 'BET', '10.00')))));
    await seeder.close();
    const ids = wallets.map((w) => w.id);
    const rows = await q<{ id: string }>(`SELECT id::text FROM outbox_messages WHERE aggregate_id = ANY(?::text[])`, [pgArray(ids)]);
    expect(rows.length).toBe(12 * 2 * 6);
    expect(await unpublishedOutbox(ids)).toBe(rows.length);

    // dois publishers (processos completos do app) sobem juntos
    await Promise.all([spawnInstance(workerEnv(), { name: 'pub-a' }), spawnInstance(workerEnv(), { name: 'pub-b' })]);
    await waitFor(async () => (await unpublishedOutbox(ids)) === 0, 60_000, 'both publishers to drain the backlog', 250);

    const wanted = new Set(rows.map((r) => r.id));
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 40_000,
      isDone: (all) => parseEvents(all).filter((e) => wanted.has(e.eventId)).length >= wanted.size,
    });
    const mine = parseEvents(msgs).filter((e) => wanted.has(e.eventId));
    expect(mine.length).toBe(rows.length);
    expect(new Set(mine.map((e) => e.eventId)).size).toBe(rows.length);
    expect(await count(`SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ANY(?::text[]) AND published_at IS NOT NULL`, [pgArray(ids)])).toBe(rows.length);
    for (const w of wallets) {
      const v = mine.filter((e) => e.aggregateId === w.id && e.eventType === 'WalletBalanceChanged').map((e) => e.data.walletVersion as number);
      expect(v).toEqual([...v].sort((a, b) => a - b));
      await assertWalletConsistent(w.id);
    }
  });
});
