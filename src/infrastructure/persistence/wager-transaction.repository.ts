import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money';
import type { FailureCode } from '../../domain/failure-codes';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { date, int, optDate, optStr, query, str, type Row } from './sql';

/**
 * JOIN com wallets: o saldo-resultado é gravado na moeda da WALLET (numeric não carrega moeda),
 * que pode diferir da moeda da transação numa rejeição CURRENCY_MISMATCH.
 */
const SELECT = `SELECT t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash,
  t.wallet_id, t.player_id, t.round_id, t.game_id, t.kind, t.amount, t.currency,
  t.reference_external_transaction_id, t.reference_transaction_id, t.status, t.failure_code,
  t.result_balance_amount, t.attempts, t.next_attempt_at, t.correlation_id, t.created_at, t.processed_at,
  w.currency AS wallet_currency
  FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id`;

export interface ClaimedPendingReference {
  tx: WagerTransaction;
  correlationId: string;
}

function toTransaction(row: Row): WagerTransaction {
  const currency = str(row, 'currency');
  const resultBalance = optStr(row, 'result_balance_amount');
  return WagerTransaction.rehydrate({
    id: str(row, 'id'),
    providerId: str(row, 'provider_id'),
    externalTransactionId: str(row, 'external_transaction_id'),
    idempotencyKey: str(row, 'idempotency_key'),
    payloadHash: str(row, 'payload_hash'),
    walletId: str(row, 'wallet_id'),
    playerId: str(row, 'player_id'),
    roundId: str(row, 'round_id'),
    gameId: str(row, 'game_id'),
    kind: str(row, 'kind') as WagerTransactionKind,
    money: Money.fromPersisted(str(row, 'amount'), currency),
    referenceExternalTransactionId: optStr(row, 'reference_external_transaction_id'),
    createdAt: date(row, 'created_at'),
    status: str(row, 'status') as WagerTransactionStatus,
    referenceTransactionId: optStr(row, 'reference_transaction_id'),
    failureCode: optStr(row, 'failure_code') as FailureCode | undefined,
    processedAt: optDate(row, 'processed_at'),
    resultBalance: resultBalance === undefined ? undefined : Money.fromPersisted(resultBalance, str(row, 'wallet_currency')),
    attempts: int(row, 'attempts'),
    nextAttemptAt: optDate(row, 'next_attempt_at'),
  });
}

@Injectable()
export class WagerTransactionRepository {
  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const rows = await query(em, `${SELECT} WHERE t.id = ?`, [id]);
    const row = rows[0];
    return row ? toTransaction(row) : null;
  }

  async findByIdempotencyKey(em: EntityManager, key: string): Promise<WagerTransaction | null> {
    const rows = await query(em, `${SELECT} WHERE t.idempotency_key = ?`, [key]);
    const row = rows[0];
    return row ? toTransaction(row) : null;
  }

  async findByProviderExternal(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await query(em, `${SELECT} WHERE t.provider_id = ? AND t.external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
    const row = rows[0];
    return row ? toTransaction(row) : null;
  }

  /** Existe REFUND/ROLLBACK PROCESSED revertendo `referenceId`? (o índice parcial uq_wtx_single_reversal é a garantia final) */
  async hasProcessedReversal(em: EntityManager, referenceId: string): Promise<boolean> {
    const rows = await query(
      em,
      `SELECT 1 AS found FROM wager_transactions
       WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED' LIMIT 1`,
      [referenceId],
    );
    return rows.length > 0;
  }

  async insert(em: EntityManager, tx: WagerTransaction, correlationId: string): Promise<void> {
    const s = tx.toState();
    await query(
      em,
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, failure_code, result_balance_amount, attempts, next_attempt_at, correlation_id,
         created_at, processed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId, s.playerId,
        s.roundId, s.gameId, s.kind, s.money.amount, s.money.currency, s.referenceExternalTransactionId ?? null,
        s.referenceTransactionId ?? null, s.status, s.failureCode ?? null, s.resultBalance?.amount ?? null,
        s.attempts, s.nextAttemptAt ?? null, correlationId, s.createdAt, s.processedAt ?? null, s.processedAt ?? s.createdAt,
      ],
    );
  }

  /**
   * Persiste apenas os campos de estado. O trigger do schema rejeita UPDATE em linha terminal, então
   * qualquer tentativa de "reabrir" uma transação falha no banco mesmo que o código erre.
   */
  async update(em: EntityManager, tx: WagerTransaction, now: Date): Promise<void> {
    const s = tx.toState();
    const rows = await query(
      em,
      `UPDATE wager_transactions SET status = ?, reference_transaction_id = ?, failure_code = ?,
         result_balance_amount = ?, attempts = ?, next_attempt_at = ?, processed_at = ?, updated_at = ?
       WHERE id = ? RETURNING id`,
      [
        s.status, s.referenceTransactionId ?? null, s.failureCode ?? null, s.resultBalance?.amount ?? null,
        s.attempts, s.nextAttemptAt ?? null, s.processedAt ?? null, now, s.id,
      ],
    );
    if (rows.length !== 1) {
      throw new Error(`wager transaction ${s.id} not found on update`);
    }
  }

  /**
   * Reivindica até `limit` transações PENDING_REFERENCE vencidas. FOR UPDATE SKIP LOCKED distribui o trabalho
   * entre instâncias sem espera: uma linha travada por outro worker é simplesmente pulada.
   * `excludeIds` evita reprocessar, na mesma rodada, itens que falharam.
   */
  async claimDuePendingReference(
    em: EntityManager,
    limit: number,
    now: Date,
    excludeIds: readonly string[] = [],
  ): Promise<ClaimedPendingReference[]> {
    const exclusion = excludeIds.length > 0 ? ` AND t.id NOT IN (${excludeIds.map(() => '?').join(', ')})` : '';
    // FOR UPDATE OF t: trava só a linha da transação, não a wallet do JOIN
    const rows = await query(
      em,
      `${SELECT} WHERE t.status = 'PENDING_REFERENCE' AND t.next_attempt_at <= ?${exclusion}
       ORDER BY t.next_attempt_at, t.id LIMIT ? FOR UPDATE OF t SKIP LOCKED`,
      [now, ...excludeIds, limit],
    );
    return rows.map((row) => ({ tx: toTransaction(row), correlationId: optStr(row, 'correlation_id') ?? '' }));
  }
}
