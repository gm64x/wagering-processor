import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../../domain/outbox-message';
import { query } from './sql';

@Injectable()
export class OutboxRepository {
  /** Mesma transação da mudança de estado: o evento só existe se o commit financeiro existir. */
  async insertMany(em: EntityManager, messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const placeholders = messages.map(() => '(?, ?, ?, ?::jsonb, ?, ?, ?)').join(', ');
    const params = messages.flatMap((m) => [
      m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt,
    ]);
    await query(
      em,
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ${placeholders} RETURNING id`,
      params,
    );
  }
}
