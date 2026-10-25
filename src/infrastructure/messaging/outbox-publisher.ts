import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_LOGGER, EVENT_PUBLISHER, METRICS, type AppLogger, type EventPublisher, type Metrics } from '../../application/ports';
import type { IntegrationEventEnvelope } from '../../domain/events/integration-event';
import { OutboxMessage, type OutboxMessageState } from '../../domain/outbox-message';
import { WorkerLoop, envInt } from './worker-loop';

const BATCH_SIZE = 50;
const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * Seleciona linhas devidas com lock de linha e sem competir com outros publishers:
 *  - FOR UPDATE OF o SKIP LOCKED: publishers concorrentes nunca pegam a mesma linha;
 *  - NOT EXISTS: uma linha só é elegível se for a mais antiga pendente do seu agregado (wallet).
 *    Assim, enquanto um publisher segura o evento N de uma wallet, nenhum outro publica o evento N+1
 *    dela, o que preserva a ordem por MessageGroupId no FIFO mesmo com vários publishers.
 */
const SELECT_DUE_SQL = `
SELECT o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at,
       o.attempts, o.next_attempt_at, o.published_at, o.last_error
FROM outbox_messages o
WHERE o.published_at IS NULL
  AND o.next_attempt_at <= now()
  AND NOT EXISTS (
    SELECT 1 FROM outbox_messages p
    WHERE p.aggregate_id = o.aggregate_id
      AND p.published_at IS NULL
      AND (p.occurred_at, p.id) < (o.occurred_at, o.id)
  )
ORDER BY o.occurred_at, o.id
LIMIT ?
FOR UPDATE OF o SKIP LOCKED`;

const MARK_PUBLISHED_SQL = `UPDATE outbox_messages SET published_at = ? WHERE id = ?`;
const MARK_RETRY_SQL = `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`;
const LAG_SQL = `
SELECT EXTRACT(EPOCH FROM (now() - min(occurred_at))) AS lag_seconds
FROM outbox_messages
WHERE published_at IS NULL`;

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

function toState(row: OutboxRow): OutboxMessageState {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publica a outbox. Entrega é at-least-once: se o processo morrer no meio do lote, a transação
 * desfaz os published_at e outra instância republica. O consumidor deduplica por eventId.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log: AppLogger;
  private readonly pollMs = envInt('OUTBOX_POLL_MS', 500);
  private readonly loop: WorkerLoop;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.log = logger.child({ component: 'outbox-publisher' });
    this.loop = new WorkerLoop(SHUTDOWN_DRAIN_MS, () =>
      this.log.warn('outbox drain timeout; unfinished batch will be rolled back and republished'),
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED !== 'false') this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.loop.start(
      async (loop) => {
        while (!loop.isStopping) {
          try {
            const published = await this.publishBatch();
            if (published === 0) await loop.sleep(this.pollMs);
          } catch (err) {
            if (loop.isStopping) break;
            this.log.error('outbox batch failed', { err });
            await loop.sleep(this.pollMs);
          }
        }
      },
      (err) => this.log.error('outbox loop crashed', { err }),
    );
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /**
   * Um lote numa única transação. As linhas ficam travadas até o COMMIT, então a publicação
   * acontece DENTRO da transação. Falha por linha agenda retry e segue para a próxima.
   * Retorna quantas linhas foram publicadas com sucesso.
   */
  async publishBatch(): Promise<number> {
    const now = new Date();
    const published = await this.em.fork().transactional(async (tem) => {
      const rows = (await tem.execute(SELECT_DUE_SQL, [BATCH_SIZE])) as OutboxRow[];
      let count = 0;
      for (const row of rows) {
        const message = OutboxMessage.rehydrate(toState(row));
        try {
          await this.publisher.publish({
            id: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            payload: message.payload,
          });
        } catch (err) {
          message.scheduleRetry(now, describe(err));
          await tem.execute(MARK_RETRY_SQL, [
            message.attempts,
            message.nextAttemptAt,
            message.lastError ?? null,
            message.id,
          ]);
          this.metrics.retry('outbox');
          this.log.warn('outbox publish failed; retry scheduled', {
            eventId: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            attempts: message.attempts,
            err,
          });
          continue;
        }
        message.markPublished(now);
        await tem.execute(MARK_PUBLISHED_SQL, [now, message.id]);
        count += 1;
      }
      return count;
    });
    await this.recordLag();
    return published;
  }

  private async recordLag(): Promise<void> {
    try {
      const rows = (await this.em.fork().execute(LAG_SQL, [])) as Array<{ lag_seconds: string | number | null }>;
      const raw = rows[0]?.lag_seconds;
      const lag = raw === null || raw === undefined ? 0 : Number(raw);
      this.metrics.outboxLagSeconds(Number.isFinite(lag) ? Math.max(0, lag) : 0);
    } catch (err) {
      this.log.warn('could not measure outbox lag', { err });
    }
  }
}
