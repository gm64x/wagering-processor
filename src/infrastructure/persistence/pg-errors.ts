import { TransientInfrastructureError } from '../../application/dto';

/**
 * Classificação de erros do driver. MikroORM embrulha o erro do `pg` numa exceção própria
 * (UniqueConstraintViolationException, ConnectionException, ...) que copia `code`/`constraint`
 * para si; erros de pool/conexão (knex) e de rede chegam crus ou com `cause`. Por isso toda
 * checagem percorre a cadeia wrapper -> cause/original/driverError.
 */

/** SQLSTATE transitórios além da classe 08 (connection exception). */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // falha de serialização (serialization_failure)
  '40P01', // deadlock detectado (deadlock_detected)
  '55P03', // lock não disponível (lock_timeout)
  '57014', // consulta cancelada (statement_timeout): a transação foi revertida, seguro repetir
  '57P01', // shutdown administrativo (admin_shutdown)
  '57P02', // shutdown por crash (crash_shutdown)
  '57P03', // não é possível conectar agora (cannot_connect_now)
  '53300', // conexões demais (too_many_connections)
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TRANSIENT_MESSAGES = [
  'connection terminated',
  'timeout acquiring a connection',
  'timeout exceeded when trying to connect',
  'terminating connection',
  'connection error',
  'the database system is starting up',
];

const TRANSIENT_CLASS_NAMES = new Set(['ConnectionException', 'DeadlockException', 'LockWaitTimeoutException']);

const MAX_DEPTH = 5;

/** wrapper + erros aninhados (cause / original / driverError), sem ciclos. */
function chain(error: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && typeof current === 'object' && current !== null; depth++) {
    const record = current as Record<string, unknown>;
    if (out.includes(record)) break;
    out.push(record);
    current = record.cause ?? record.original ?? record.driverError;
  }
  return out;
}

function sqlState(e: Record<string, unknown>): string | undefined {
  const code = e.sqlState ?? e.code;
  return typeof code === 'string' ? code : undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return chain(error).some((e) => {
    if (sqlState(e) !== '23505') return false;
    if (constraint === undefined) return true;
    if (e.constraint === constraint) return true;
    // fallback: o texto do pg cita o nome da constraint entre aspas
    return typeof e.message === 'string' && e.message.includes(`"${constraint}"`);
  });
}

/** lock_timeout estourou (55P03): contenção prolongada na wallet. */
export function isLockTimeout(error: unknown): boolean {
  return chain(error).some((e) => sqlState(e) === '55P03' || e.constructor?.name === 'LockWaitTimeoutException');
}

export function isTransientDbError(error: unknown): boolean {
  if (error instanceof TransientInfrastructureError) return true;
  return chain(error).some((e) => {
    const state = sqlState(e);
    if (state !== undefined) {
      if (state.startsWith('08') || TRANSIENT_SQLSTATES.has(state)) return true;
      if (TRANSIENT_NODE_CODES.has(state)) return true;
    }
    if (typeof e.errno === 'string' && TRANSIENT_NODE_CODES.has(e.errno)) return true;
    if (TRANSIENT_CLASS_NAMES.has(e.constructor?.name ?? '')) return true;
    if (typeof e.message === 'string') {
      const message = e.message.toLowerCase();
      return TRANSIENT_MESSAGES.some((fragment) => message.includes(fragment));
    }
    return false;
  });
}

/** Converte erro transitório de banco em TransientInfrastructureError; qualquer outro é relançado como está. */
export function toTransient(error: unknown): never {
  if (error instanceof TransientInfrastructureError) throw error;
  if (isTransientDbError(error)) {
    const message = error instanceof Error ? error.message : 'database unavailable';
    throw new TransientInfrastructureError(`transient database failure: ${message}`, error);
  }
  throw error;
}

/**
 * Campos seguros para log. A mensagem de erro do MikroORM/pg embute o SQL com os parâmetros interpolados
 * (valores monetários, ids), então o erro cru nunca vai para o logger: só classe e SQLSTATE.
 */
export function describeDbError(error: unknown): { errorName: string; errorCode?: string } {
  const first = chain(error)[0];
  const code = chain(error).map(sqlState).find((c) => c !== undefined);
  return { errorName: first?.constructor?.name ?? typeof error, ...(code !== undefined ? { errorCode: code } : {}) };
}
