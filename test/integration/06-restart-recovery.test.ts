import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, getWallet, submit, toSqsData } from '../support/api';
import { killAllInstances, spawnInstance } from '../support/app';
import { assertWalletConsistent, closeDb, count, ledgerCount, q, unpublishedOutbox, walletBalance } from '../support/db';
import { createTestQueues, drainMessages, parseEvents, queueTotal, sendWager, waitQueueEmpty, type TestQueues } from '../support/sqs';
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

describe('recuperação após restart', () => {
  it('commit, kill -9 antes de qualquer publish, restart: o estado fica íntegro e o outbox pendente é publicado pelo novo processo', async () => {
    // instância A: só HTTP (workers desligados) => commits acontecem, nada é publicado
    const a = await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'false' }, { name: 'restart-a' });
    const w = await createWallet(a.url, '500.00');
    for (let i = 0; i < 5; i++) expect((await submit(a.url, buildTx(w, 'BET', '10.00'))).status).toBe(201);
    expect((await submit(a.url, buildTx(w, 'WIN', '25.00'))).status).toBe(201);

    const eventRows = await q<{ id: string }>(`SELECT id::text FROM outbox_messages WHERE aggregate_id = ?`, [w.id]);
    expect(eventRows.length).toBe(2 + 5 * 2 + 2); // opening + 5 bets + win (Processed + BalanceChanged cada)
    expect(await unpublishedOutbox([w.id])).toBe(eventRows.length); // commitado no Postgres, ainda não no SQS

    const killed = await a.kill('SIGKILL');
    expect(killed.signalCode ?? killed.exitCode).not.toBe(0);

    // estado após o crash é exatamente o que foi commitado
    expect(await walletBalance(w.id)).toBe('475.00');
    await assertWalletConsistent(w.id);

    // instância B assume
    const b = await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true' }, { name: 'restart-b' });
    await waitFor(async () => (await unpublishedOutbox([w.id])) === 0, 30_000, 'restarted instance to publish the pending outbox');

    const wanted = new Set(eventRows.map((r) => r.id));
    const msgs = await drainMessages(queues.eventsUrl, {
      timeoutMs: 30_000,
      isDone: (all) => parseEvents(all).filter((e) => wanted.has(e.eventId)).length >= wanted.size,
    });
    const mine = parseEvents(msgs).filter((e) => wanted.has(e.eventId));
    expect(mine.length).toBe(wanted.size);
    expect(new Set(mine.map((e) => e.eventId)).size).toBe(wanted.size);
    // a trilha de saldos publicada termina no saldo commitado
    const last = mine.filter((e) => e.eventType === 'WalletBalanceChanged').at(-1)!;
    expect(last.data.balanceAfter.amount).toBe('475.00');

    // o novo processo serve o mesmo estado e não aplica nada duas vezes
    expect((await getWallet(b.url, w.id)).balance.amount).toBe('475.00');
    expect(await ledgerCount(w.id)).toBe(1 + 5 + 1);
    await assertWalletConsistent(w.id);
  });

  it('mensagens que chegaram sem nenhum processo rodando são aplicadas exatamente uma vez após o restart', async () => {
    const setup = await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'false' }, { name: 'restart-setup' });
    const w = await createWallet(setup.url, '200.00');
    await setup.kill('SIGKILL'); // a frota inteira está fora

    const reqs = Array.from({ length: 6 }, () => buildTx(w, 'BET', '10.00'));
    for (const r of reqs) await sendWager(queues.mainUrl, toSqsData(r));
    await sendWager(queues.mainUrl, toSqsData(reqs[0]!)); // uma duplicata só por garantia
    expect(await count('SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = ?', [w.id, 'BET'])).toBe(0);

    await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true' }, { name: 'restart-consumer' });
    await waitFor(
      async () => (await count('SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = ?', [w.id, 'BET'])) === 6,
      30_000,
      'all queued BETs applied',
    );
    await waitQueueEmpty(queues.mainUrl, 30_000);
    await waitFor(async () => (await unpublishedOutbox([w.id])) === 0, 30_000, 'outbox published');

    expect(await walletBalance(w.id)).toBe('140.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(6);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    await assertWalletConsistent(w.id);
  });
});
