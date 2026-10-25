import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../domain/inbox-message';
import { query } from './sql';

@Injectable()
export class InboxRepository {
  /**
   * Registra (consumer, messageId) na transação corrente. `false` = já existia (redelivery/duplicata).
   * ON CONFLICT DO NOTHING espera o commit/rollback de uma inserção concorrente da mesma chave, então
   * se a primeira transação reverter, esta insere; se comitar, esta recebe 0 linhas.
   */
  async tryInsert(em: EntityManager, message: InboxMessage): Promise<boolean> {
    const rows = await query(
      em,
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }
}
