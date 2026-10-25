import './env';
import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { createdWalletIds } from './api';
import config from '../../src/infrastructure/persistence/mikro-orm.config';

let orm: MikroORM | undefined;

/** Conexão compartilhada usada nas asserções (Postgres real, sem mocks). Pool pequeno: só roda queries de verificação. */
export async function db(): Promise<MikroORM> {
  if (!orm) {
    orm = await MikroORM.init({ ...config, pool: { min: 1, max: 5 } });
  }
  return orm;
}

/**
 * Limpeza de testes: eventos de wallets criadas por um arquivo de teste já finalizado, que nenhum publisher tratou,
 * são marcados como publicados para não acumularem e não serem descarregados (para a fila de outro teste) pelos
 * publishers de um arquivo posterior. Ledger e transactions nunca são tocados (append-only).
 */
export async function retireOutbox(): Promise<void> {
  if (createdWalletIds.length === 0) return;
  await q(`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND aggregate_id = ANY(?::text[]) RETURNING id`, [
    pgArray(createdWalletIds),
  ]);
}

export async function closeDb(): Promise<void> {
  await retireOutbox().catch(() => undefined);
  if (orm) {
    await orm.close(true);
    orm = undefined;
  }
}

export type Row = Record<string, any>;

export async function q<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const o = await db();
  return (await o.em.fork().execute(sql, params)) as unknown as T[];
}

export async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`no row for: ${sql}`);
  return Object.values(row)[0] as T;
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number(await scalar(sql, params));
}

/** Rejeita com o erro do driver para que os testes possam casar pelo nome da constraint / trigger. */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, 'esperado que o banco rejeitasse o statement').toBeDefined();
  const text = `${(error as Error).message} ${(error as { constraint?: string }).constraint ?? ''}`;
  expect(text).toMatch(pattern);
}

/**
 * Invariante final (spec, seção 13): wallet.balance == saldo reconstruído a partir do ledger.
 * Também verifica: == último balance_after, nunca negativo, e uma cadeia before/after contínua.
 */
export async function assertWalletConsistent(walletId: string): Promise<void> {
  const [wallet] = await q<{ balance_amount: string }>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
  expect(wallet, `wallet ${walletId} existe`).toBeDefined();
  const [sums] = await q<{ credits: string; debits: string; entries: string }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
            COUNT(*)::text AS entries
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  const [calc] = await q<{ rebuilt: string; stored: string; negative: boolean }>(
    `SELECT (?::numeric - ?::numeric)::text AS rebuilt, ?::numeric::text AS stored, (?::numeric < 0) AS negative`,
    [sums!.credits, sums!.debits, wallet!.balance_amount, wallet!.balance_amount],
  );
  expect(calc!.negative, 'saldo nunca pode ser negativo').toBe(false);
  expect(Number(calc!.rebuilt), `wallet ${walletId}: saldo armazenado == créditos - débitos`).toBe(Number(calc!.stored));
  expect(calc!.rebuilt).toBe(calc!.stored);

  const [last] = await q<{ balance_after_amount: string }>(
    'SELECT balance_after_amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq DESC LIMIT 1',
    [walletId],
  );
  if (last) expect(last.balance_after_amount, `wallet ${walletId}: último balance_after == armazenado`).toBe(wallet!.balance_amount);
  else expect(Number(wallet!.balance_amount)).toBe(0);

  const broken = await count(
    `SELECT COUNT(*) FROM (
       SELECT balance_before_amount,
              LAG(balance_after_amount) OVER (ORDER BY seq) AS prev_after,
              ROW_NUMBER() OVER (ORDER BY seq) AS rn
       FROM wallet_ledger_entries WHERE wallet_id = ?) t
     WHERE rn > 1 AND balance_before_amount <> prev_after`,
    [walletId],
  );
  expect(broken, `wallet ${walletId}: cadeia before/after do ledger é contínua`).toBe(0);

  const dupes = await count(
    `SELECT COUNT(*) FROM (SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ?
       GROUP BY transaction_id HAVING COUNT(*) > 1) d`,
    [walletId],
  );
  expect(dupes, `wallet ${walletId}: no máximo uma entrada de ledger por transação`).toBe(0);
}

export async function walletBalance(walletId: string): Promise<string> {
  return scalar('SELECT balance_amount::text FROM wallets WHERE id = ?', [walletId]);
}

export async function ledgerCount(walletId: string, direction?: 'DEBIT' | 'CREDIT'): Promise<number> {
  return direction
    ? count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?', [walletId, direction])
    : count('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
}

export async function unpublishedOutbox(walletIds: string[]): Promise<number> {
  if (walletIds.length === 0) return 0;
  return count(
    `SELECT COUNT(*) FROM outbox_messages WHERE published_at IS NULL AND aggregate_id = ANY(?::text[])`,
    [pgArray(walletIds)],
  );
}

/** Literal de array do Postgres para uma lista de ids simples (uuids); evita que o knex expanda arrays JS em lista separada por vírgula. */
export function pgArray(ids: string[]): string {
  return `{${ids.join(',')}}`;
}
