import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Resultado de em.execute() (método 'all'), verificado empiricamente no MikroORM 6 + pg:
 *  - SELECT                      -> array de linhas (vazio se nenhuma)
 *  - INSERT/UPDATE ... RETURNING -> array das linhas retornadas ([] se nenhuma foi afetada)
 *  - INSERT/UPDATE sem RETURNING -> [] (rowCount NÃO é exposto)
 * Por isso todo comando cujo número de linhas importa usa RETURNING e conta `rows.length`.
 * Numeric chega como string; bigint (seq) como string; timestamptz como string "YYYY-MM-DD HH:MM:SS.ffffff+00".
 */
export type Row = Record<string, unknown>;

export async function query<T extends Row = Row>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await em.execute(sql, params)) as unknown as T[];
}

export function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new Error(`column ${key} expected string, got ${typeof v}`);
  return v;
}

export function optStr(row: Row, key: string): string | undefined {
  const v = row[key];
  return v === null || v === undefined ? undefined : String(v);
}

export function int(row: Row, key: string): number {
  const v = row[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`column ${key} expected integer, got ${String(v)}`);
  return n;
}

/** timestamptz: o driver devolve Date em alguns caminhos e string em outros. */
export function date(row: Row, key: string): Date {
  const d = optDate(row, key);
  if (d === undefined) throw new Error(`column ${key} expected timestamp`);
  return d;
}

export function optDate(row: Row, key: string): Date | undefined {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  const d = new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(d.getTime())) throw new Error(`column ${key} has invalid timestamp ${String(v)}`);
  return d;
}
