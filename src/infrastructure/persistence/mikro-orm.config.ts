import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261025000001_initial } from '../../../migrations/Migration20261025000001_initial';
import { Migration20261025000002_outbox_aggregate_index } from '../../../migrations/Migration20261025000002_outbox_aggregate_index';

/**
 * MikroORM é usado como camada de conexão, Unit of Work transacional (em.transactional)
 * e migrator. O caminho financeiro usa SQL explícito via em.execute() dentro da transação
 * (ver ARCHITECTURE.md: SELECT ... FOR UPDATE, ON CONFLICT DO NOTHING, FOR UPDATE SKIP LOCKED).
 * O domínio não conhece o ORM: os repositórios mapeiam linhas <-> agregados via rehydrate().
 */
export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  pool: { min: 2, max: Number(process.env.DB_POOL_MAX ?? 20) },
  driverOptions: { connection: { statement_timeout: 10_000 } },
  migrations: {
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
    // migrations listadas explicitamente: funciona igual em Bun, Node e dentro do container
    migrationsList: [
      { name: 'Migration20261025000001_initial', class: Migration20261025000001_initial },
      { name: 'Migration20261025000002_outbox_aggregate_index', class: Migration20261025000002_outbox_aggregate_index },
    ],
  },
  debug: process.env.ORM_DEBUG === '1',
});
