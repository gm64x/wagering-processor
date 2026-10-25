import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, submitWithFailover, toSqsData, type TxRequest, type WalletRef } from '../support/api';
import { killAllInstances, spawnInstance, type Instance } from '../support/app';
import { assertWalletConsistent, closeDb, count, pgArray, q, unpublishedOutbox, walletBalance } from '../support/db';
import { createTestQueues, drainMessages, parseEvents, queueTotal, sendWagerBatch, waitQueueEmpty, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait';

let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 3 });
});
afterEach(async () => {
  await killAllInstances();
});
afterAll(async () => {
  await queues.cleanup();
  await closeDb();
});

const cents = (amount: string): number => Math.round(Number(amount) * 100);
const fmt = (c: number): string => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;

describe('restart do serviço com prova de consistência final', () => {
  it('C8: carga por 3 processos, kill -9 em um deles no meio do voo, reinicia -> toda wallet consistente, um efeito por operação, outbox totalmente publicado', async () => {
    const env = { ...queues.env, WORKERS_ENABLED: 'true', SQS_MAX_RECEIVES: '5' };
    const fleet: Instance[] = await Promise.all([0, 1, 2].map((i) => spawnInstance(env, { name: `c8-${i}` })));
    const urls = fleet.map((i) => i.url);

    const K = 6;
    const wallets: WalletRef[] = await Promise.all(Array.from({ length: K }, () => createWallet(urls[0]!, '100000.00')));
    // nunca falta dinheiro => sem rejeições de negócio: o saldo final esperado é calculável a partir do que enviamos
    const httpOps: TxRequest[] = [];
    const sqsOps: TxRequest[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 25; i++) httpOps.push(i % 5 === 4 ? buildTx(w, 'WIN', '4.50') : buildTx(w, 'BET', '10.00'));
      for (let i = 0; i < 15; i++) sqsOps.push(i % 5 === 4 ? buildTx(w, 'WIN', '4.50') : buildTx(w, 'BET', '10.00'));
    }
    const all = [...httpOps, ...sqsOps];
    const expected = new Map<string, number>(wallets.map((w) => [w.id, 10_000_000]));
    for (const op of all) {
      expected.set(op.walletId, expected.get(op.walletId)! + (op.kind === 'WIN' ? 1 : -1) * cents(op.money.amount));
    }

    // lado SQS primeiro (para as mensagens estarem em voo quando o processo morrer), com algumas duplicatas
    const sqsItems = sqsOps.map((r) => ({ data: toSqsData(r), messageId: `m-${r.externalTransactionId}` }));
    await sendWagerBatch(queues.mainUrl, [...sqsItems, ...sqsItems.slice(0, 20)]);

    // lado HTTP: 12 clientes concorrentes com failover (um provider reenviando com a mesma Idempotency-Key)
    let done = 0;
    let kills = 0;
    let cursor = 0;
    const killAt = Math.floor(httpOps.length * 0.3);
    let killedAndRestarted: Promise<void> | undefined;
    const client = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= httpOps.length) return;
        const op = httpOps[i]!;
        const r = await submitWithFailover(urls, op, i, 40);
        if (r.status >= 400) throw new Error(`unexpected ${r.status} ${JSON.stringify(r.body)}`);
        done++;
        if (done === killAt && !killedAndRestarted) {
          killedAndRestarted = (async () => {
            await fleet[1]!.kill('SIGKILL'); // sem chance de terminar, dar ack ou publicar nada
            kills++;
            await new Promise((res) => setTimeout(res, 1500));
            fleet[1] = await spawnInstance(env, { name: 'c8-1-restarted', port: fleet[1]!.port });
          })();
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, client));
    await killedAndRestarted;
    expect(kills).toBe(1);
    expect(fleet[1]!.name).toContain('restarted');

    // espera tudo assentar: cada mensagem SQS aplicada e com ack, outbox drenado
    const ids = wallets.map((w) => w.id);
    await waitFor(
      async () => (await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) AND kind <> 'OPENING'`, [pgArray(ids)])) === all.length,
      90_000,
      `all ${all.length} operations recorded`,
      250,
    );
    await waitQueueEmpty(queues.mainUrl, 90_000);
    await waitFor(async () => (await unpublishedOutbox(ids)) === 0, 90_000, 'outbox fully published', 250);

    // um efeito por operação: cada chave exatamente uma vez, nada travado, nada rejeitado, nada na DLQ
    expect(
      await count(
        `SELECT COUNT(*) FROM (SELECT idempotency_key FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) GROUP BY 1 HAVING COUNT(*) > 1) d`,
        [pgArray(ids)],
      ),
    ).toBe(0);
    expect(
      await count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) AND kind <> 'OPENING' AND status <> 'PROCESSED'`, [pgArray(ids)]),
    ).toBe(0);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe(fmt(expected.get(w.id)!));
      await assertWalletConsistent(w.id);
      // exatamente uma entrada de ledger por transação que move saldo (OPENING + 25+15 ops, todas movem dinheiro)
      expect(await count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?', [w.id])).toBe(1 + 40);
    }

    // eventos: cada linha do outbox chegou à fila de eventos exatamente uma vez (nenhuma perdida no kill)
    const dbEvents = await q<{ id: string }>(`SELECT id::text FROM outbox_messages WHERE aggregate_id = ANY(?::text[])`, [pgArray(ids)]);
    const wanted = new Set(dbEvents.map((e) => e.id));
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 60_000,
      isDone: (got) => new Set(parseEvents(got).map((e) => e.eventId).filter((id) => wanted.has(id))).size >= wanted.size,
    });
    const received = parseEvents(msgs).filter((e) => wanted.has(e.eventId));
    expect(new Set(received.map((e) => e.eventId)).size).toBe(wanted.size);
    expect(received.length).toBe(wanted.size);
    for (const w of wallets) {
      const v = received.filter((e) => e.aggregateId === w.id && e.eventType === 'WalletBalanceChanged').map((e) => e.data.walletVersion as number);
      expect(v.length).toBe(41);
      expect(v).toEqual([...v].sort((a, b) => a - b));
    }
    console.log(`C8: ${all.length} ops, ${wanted.size} events, one process kill -9 + restart`);
  });
});
