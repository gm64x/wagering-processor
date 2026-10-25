import { Inject, Injectable, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { describeDbError, isLockTimeout, isTransientDbError } from '../infrastructure/persistence/pg-errors';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import { APP_LOGGER, CLOCK, METRICS, type AppLogger, type Clock, type Metrics } from './ports';
import { WagerEngine, positiveIntEnv } from './wager-engine';
import { LOCK_TIMEOUT_SQL, systemClock } from './wagering.service';

const BATCH_SIZE = 20;

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (referência chegou fora de ordem).
 * Cada item roda na SUA transação: [claim da linha FOR UPDATE SKIP LOCKED] -> [lock da wallet] -> regras.
 * Uma transação por item evita segurar vários locks de wallet ao mesmo tempo (sem deadlock entre workers) e isola falhas.
 * Ordem de locks: linha da transação -> wallet. O caminho de submit trava só a wallet e nunca trava linhas de
 * transações existentes (só lê), então não há ciclo entre os dois.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly clock: Clock;
  private readonly maxAttempts = positiveIntEnv('PENDING_REF_MAX_ATTEMPTS', 8);
  private readonly pollMs = positiveIntEnv('PENDING_REF_POLL_MS', 1000);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(WagerEngine) private readonly engine: WagerEngine,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.stopped = false;
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight; // deixa a transação em andamento terminar
  }

  /** Processa até BATCH_SIZE transações vencidas e devolve quantas foram resolvidas (processadas, rejeitadas ou re-agendadas). */
  async runOnce(): Promise<number> {
    let handled = 0;
    const failed: string[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const outcome = await this.processNext(failed);
      if (outcome === 'empty') break;
      if (outcome.error) {
        failed.push(outcome.id);
        continue;
      }
      handled++;
    }
    return handled;
  }

  private async processNext(excludeIds: string[]): Promise<'empty' | { id: string; error: boolean }> {
    const started = performance.now();
    let claimedId: string | undefined;
    try {
      const outcome = await this.orm.em.fork().transactional(async (em) => {
        await em.execute(LOCK_TIMEOUT_SQL);
        const now = this.clock.now();
        const [claimed] = await this.transactions.claimDuePendingReference(em, 1, now, excludeIds);
        if (!claimed) return undefined;
        claimedId = claimed.tx.id;

        const wallet = await this.wallets.lockById(em, claimed.tx.walletId);
        if (!wallet) throw new Error(`wallet ${claimed.tx.walletId} missing for transaction ${claimed.tx.id}`); // FK: impossível
        await this.engine.settle(em, wallet, claimed.tx, {
          mode: 'update',
          correlationId: claimed.correlationId || claimed.tx.id,
          now,
          maxAttempts: this.maxAttempts,
        });
        return { id: claimed.tx.id, status: claimed.tx.status, walletId: claimed.tx.walletId, correlationId: claimed.correlationId };
      });
      if (!outcome) return 'empty';
      this.metrics.processingLatency((performance.now() - started) / 1000, 'worker');
      this.metrics.retry('pending_reference');
      this.logger.info('pending reference resolved', {
        transactionId: outcome.id,
        walletId: outcome.walletId,
        correlationId: outcome.correlationId,
        status: outcome.status,
      });
      return { id: outcome.id, error: false };
    } catch (e) {
      // A transação do item foi revertida; a linha continua PENDING_REFERENCE e será tentada de novo no próximo ciclo.
      if (isLockTimeout(e)) this.metrics.lockConflict();
      const transient = isTransientDbError(e);
      this.logger[transient ? 'warn' : 'error']('pending reference processing failed', { transactionId: claimedId, ...describeDbError(e) });
      if (claimedId === undefined) return 'empty'; // falha antes do claim (banco fora): encerra a rodada
      return { id: claimedId, error: true };
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce()
        .catch((e: unknown) => this.logger.error('pending reference worker loop failed', { err: e }))
        .finally(() => this.schedule(this.pollMs));
    }, delayMs);
  }
}
