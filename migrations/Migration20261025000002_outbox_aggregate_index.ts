import { Migration } from '@mikro-orm/migrations';

/**
 * O publisher só elege a linha pendente mais antiga de cada agregado (preserva a ordem por wallet
 * no FIFO com N publishers). Este índice parcial atende o NOT EXISTS dessa consulta.
 */
export class Migration20261025000002_outbox_aggregate_index extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX ix_outbox_pending_by_aggregate ON outbox_messages (aggregate_id, occurred_at, id)
      WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS ix_outbox_pending_by_aggregate;');
  }
}
