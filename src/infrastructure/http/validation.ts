import type { SubmitWagerTransactionCommand } from '../../application/dto';
import { DomainError, ValidationError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction';

/**
 * Validadores escritos à mão (sem class-validator). Todos lançam ValidationError (domínio),
 * que o exception filter converte em 400 VALIDATION_ERROR.
 *
 * Regra geral: strings sem espaços nas bordas, sem caracteres de controle, com teto de tamanho.
 * Valores monetários só aceitam string decimal; número JSON é rejeitado.
 */

export const LIMITS = {
  defaultString: 255,
  providerId: 64,
  externalId: 128,
  roundOrGame: 128,
  idempotencyKey: 512,
  cursor: 512,
} as const;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LIMIT_RAW = /^\d{1,4}$/;

/** Kinds que a API aceita. OPENING é interno (criado pelo WalletService). */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export interface StringOptions {
  max?: number;
}

function fail(message: string): never {
  throw new ValidationError(message);
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function checkString(value: unknown, field: string, opts: StringOptions): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.trim().length === 0) fail(`${field} must not be empty`);
  if (value !== value.trim()) fail(`${field} must not have leading or trailing spaces`);
  const max = opts.max ?? LIMITS.defaultString;
  if (value.length > max) fail(`${field} must have at most ${max} characters`);
  if (CONTROL_CHARS.test(value)) fail(`${field} must not contain control characters`);
  return value;
}

/** Campo obrigatório do objeto `obj` (corpo JSON ou parâmetros de rota). */
export function requireString(obj: unknown, field: string, opts: StringOptions = {}): string {
  const value = requireObject(obj, 'request')[field];
  if (value === undefined || value === null) fail(`${field} is required`);
  return checkString(value, field, opts);
}

/** Campo opcional: ausente ou null vira undefined; presente precisa ser string válida. */
export function optionalString(obj: unknown, field: string, opts: StringOptions = {}): string | undefined {
  const value = requireObject(obj, 'request')[field];
  if (value === undefined || value === null) return undefined;
  return checkString(value, field, opts);
}

export function requireUuid(obj: unknown, field: string): string {
  const value = requireString(obj, field, { max: 36 });
  if (!UUID.test(value)) fail(`${field} must be a UUID`);
  return value;
}

export function requireOneOf<T extends string>(obj: unknown, field: string, allowed: readonly T[]): T {
  const value = requireString(obj, field, { max: 64 });
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Valida o objeto monetário: { amount: string, currency: string } e nada além disso.
 * Delega a validação numérica a Money.from e devolve a forma normalizada (ex.: "25" -> "25.00").
 */
export function parseMoneyProps(value: unknown, field: string): MoneyProps {
  if (value === undefined || value === null) fail(`${field} is required`);
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object with "amount" and "currency"`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'amount' && key !== 'currency') fail(`${field}.${key} is not allowed`);
  }
  const { amount, currency } = obj;
  if (typeof amount !== 'string') {
    fail(`${field}.amount must be a decimal string such as "25.00" (JSON numbers are not accepted)`);
  }
  if (typeof currency !== 'string') fail(`${field}.currency must be a string`);
  try {
    return Money.from({ amount, currency }).toJSON();
  } catch (err) {
    if (err instanceof DomainError) fail(`${field}: ${err.message}`);
    throw err;
  }
}

/** Query `limit`: inteiro entre 1 e max; ausente usa o padrão. */
export function parseLimit(raw: unknown, fallback = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !LIMIT_RAW.test(raw)) {
    fail(`limit must be an integer between 1 and ${max}`);
  }
  const n = Number(raw);
  if (n < 1 || n > max) fail(`limit must be an integer between 1 and ${max}`);
  return n;
}

/** Query `cursor`: opaco para o cliente; a validade do conteúdo é decidida pelo WalletService. */
export function parseOptionalCursor(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') fail('cursor must be a single value');
  if (raw.length === 0) return undefined;
  if (raw.length > LIMITS.cursor) fail(`cursor must have at most ${LIMITS.cursor} characters`);
  if (CONTROL_CHARS.test(raw)) fail('cursor must not contain control characters');
  return raw;
}

/** Header Idempotency-Key: obrigatório, não vazio, até 512 caracteres. */
export function parseIdempotencyKey(raw: unknown): string {
  if (raw === undefined) fail('Idempotency-Key header is required');
  return checkString(raw, 'Idempotency-Key', { max: LIMITS.idempotencyKey });
}

/** Corpo de POST /wallets. */
export function parseCreateWalletBody(body: unknown): { playerId: string; initialBalance: MoneyProps } {
  return {
    playerId: requireUuid(body, 'playerId'),
    initialBalance: parseMoneyProps(requireObject(body, 'request body').initialBalance, 'initialBalance'),
  };
}

export type SubmitWagerTransactionFields = Omit<
  SubmitWagerTransactionCommand,
  'idempotencyKey' | 'correlationId' | 'inbox'
>;

/** Corpo de POST /wagering/transactions (campos de negócio; o header é validado à parte). */
export function parseSubmitWagerTransactionBody(body: unknown): SubmitWagerTransactionFields {
  const obj = requireObject(body, 'request body');
  const fields: SubmitWagerTransactionFields = {
    providerId: requireString(obj, 'providerId', { max: LIMITS.providerId }),
    externalTransactionId: requireString(obj, 'externalTransactionId', { max: LIMITS.externalId }),
    playerId: requireUuid(obj, 'playerId'),
    walletId: requireUuid(obj, 'walletId'),
    roundId: requireString(obj, 'roundId', { max: LIMITS.roundOrGame }),
    gameId: requireString(obj, 'gameId', { max: LIMITS.roundOrGame }),
    kind: requireOneOf(obj, 'kind', SUBMITTABLE_KINDS),
    money: parseMoneyProps(obj.money, 'money'),
  };
  const reference = optionalString(obj, 'referenceExternalTransactionId', { max: LIMITS.externalId });
  if (reference !== undefined) fields.referenceExternalTransactionId = reference;
  return fields;
}
