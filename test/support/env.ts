/**
 * Precisa ser importado ANTES de qualquer coisa de src/ no processo de teste: src/infrastructure/persistence/mikro-orm.config.ts
 * lê DB_POOL_MAX / DATABASE_URL no momento do import.
 */
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DB_POOL_MAX ??= '8';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const LOG_DIR = process.env.TEST_LOG_DIR ?? join(tmpdir(), 'wagering-test-logs');
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

/** Env para processo filho / app em processo. Intervalos de polling curtos para os testes não ficarem parados. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL,
    SQS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    LOG_LEVEL: 'info',
    DB_POOL_MAX: '8',
    SQS_WAIT_SECONDS: '1',
    SQS_VISIBILITY_BACKOFF_MAX_S: '1',
    OUTBOX_POLL_MS: '100',
    PENDING_REF_POLL_MS: '200',
    PENDING_REF_BASE_DELAY_MS: '100',
    ...extra,
  };
}
