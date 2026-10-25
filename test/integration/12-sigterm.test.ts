import '../support/env';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { buildTx, createWallet, toSqsData, type TxRequest, type WalletRef } from '../support/api';
import { killAllInstances, spawnInstance, startInProcessApp, type InProcessApp } from '../support/app';
import { assertWalletConsistent, closeDb, count, pgArray, walletBalance } from '../support/db';
import { createTestQueues, queueCounts, queueTotal, sendWagerBatch, waitQueueEmpty, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait';

let queues: TestQueues;
let seeder: InProcessApp;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeout: 5 });
  seeder = await startInProcessApp(queues.env);
});
afterEach(async () => {
  await killAllInstances();
});
afterAll(async () => {
  await seeder.close();
  await queues.cleanup();
  await closeDb();
});

describe('shutdown gracioso (SIGTERM)', () => {
  it('SIGTERM durante o consumo: o processo sai limpo em até ~12s e as mensagens não processadas são reenviadas para outra instância sem perda', async () => {
    const wallets: WalletRef[] = await Promise.all(Array.from({ length: 8 }, () => createWallet(seeder.baseUrl, '10000.00')));
    const ops: TxRequest[] = wallets.flatMap((w) => Array.from({ length: 25 }, () => buildTx(w, 'BET', '10.00')));
    const ids = wallets.map((w) => w.id);

    // long polling no padrão de produção (5s): o SIGTERM também precisa interromper uma recepção que está esperando
    const first = await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true', SQS_WAIT_SECONDS: '5' }, { name: 'term-1' });
    await sendWagerBatch(queues.mainUrl, ops.map((o) => ({ data: toSqsData(o) })));

    const applied = () =>
      count(`SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) AND kind = 'BET'`, [pgArray(ids)]);
    await waitFor(async () => (await applied()) >= 10, 30_000, 'the first instance to start consuming', 20);

    const t0 = Date.now();
    const exit = await first.kill('SIGTERM');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(12_000);
    // gracioso: ou um exit(0) normal, ou o SIGTERM relançado pelo Nest após um shutdown completo; nunca um código de crash
    expect(exit.exitCode === 0 || exit.signalCode === 'SIGTERM' || exit.signalCode === 15).toBe(true);
    const log = await first.readLog();
    expect(log).not.toContain('consumer drain timeout');
    expect(log).not.toContain('outbox drain timeout');

    // Nada pode ficar oculto além do visibility timeout (5s aqui). Mensagens que o processo recebeu mas não começou são
    // devolvidas na hora (visibility 0); só uma recepção abortada no meio do voo pelo próprio SIGTERM pode deixar
    // até um lote oculto até o visibility timeout expirar (o SQS já contou como entregue).
    await waitFor(async () => (await queueCounts(queues.mainUrl)).inFlight === 0, 9_000, 'no message left in flight by the stopped process', 100);

    const afterTerm = await applied();
    console.log(`SIGTERM: exit=${JSON.stringify(exit)} in ${elapsed}ms; ${afterTerm}/${ops.length} applied before shutdown`);
    // nada fica pela metade: o que foi commitado está consistente agora
    for (const w of wallets) await assertWalletConsistent(w.id);

    // uma segunda instância termina o trabalho: nenhuma mensagem perdida, nenhum efeito duplicado
    await spawnInstance({ ...queues.env, WORKERS_ENABLED: 'true' }, { name: 'term-2' });
    await waitFor(async () => (await applied()) === ops.length, 60_000, 'second instance to finish all operations', 250);
    await waitQueueEmpty(queues.mainUrl, 60_000);
    expect(await queueTotal(queues.dlqUrl)).toBe(0);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('9750.00'); // 10000 - 25 * 10
      await assertWalletConsistent(w.id);
    }
    expect(
      await count(
        `SELECT COUNT(*) FROM (SELECT idempotency_key FROM wager_transactions WHERE wallet_id = ANY(?::text[]::uuid[]) GROUP BY 1 HAVING COUNT(*) > 1) d`,
        [pgArray(ids)],
      ),
    ).toBe(0);
  });
});
