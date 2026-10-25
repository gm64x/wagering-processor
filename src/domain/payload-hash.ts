import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';
import type { WagerTransactionKind } from './wager-transaction';

/** Campos que definem a semântica de negócio de uma transação. Usados para detectar conflito de idempotência. */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON determinístico: chaves ordenadas recursivamente, sem espaços, valores undefined omitidos
 * em objetos (em arrays viram null, como no JSON.stringify), ordem de arrays preservada.
 * Objetos com toJSON (ex.: Money, Date) são serializados pelo próprio toJSON.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'null';
}

export function computePayloadHash(fields: WagerBusinessFields): string {
  // Seleção explícita: campos extras do chamador não alteram o hash.
  const business = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business), 'utf8').digest('hex');
}

function normalize(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return normalize((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalize(item)));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        continue;
      }
      out[key] = normalize(item);
    }
    return out;
  }
  return value;
}
