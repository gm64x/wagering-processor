import { DomainError } from '../domain/errors';
import type { FailureCode } from '../domain/failure-codes';
import type { MoneyProps } from '../domain/money';
import type { WagerTransactionStatus } from '../domain/wager-transaction';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** presente quando a entrada é SQS: registro de inbox entra na MESMA transação SQL */
  inbox?: { consumerName: string; messageId: string };
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  resultBalance: MoneyProps | null;
  attempts: number;
  createdAt: string;
  processedAt: string | null;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

// ---- erros de aplicação (mapeados para HTTP pelo exception filter e para ack/retry/DLQ pelo consumidor)

export class IdempotencyConflictError extends DomainError {
  override readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}
export class WalletNotFoundError extends DomainError {
  override readonly code = 'WALLET_NOT_FOUND';
}
export class WalletAlreadyExistsError extends DomainError {
  override readonly code = 'WALLET_ALREADY_EXISTS';
}
export class NotFoundError extends DomainError {
  override readonly code = 'NOT_FOUND';
}
/** Só SQS: inbox já contém (consumerName, messageId). Consumidor faz ack. */
export class DuplicateMessageError extends DomainError {
  override readonly code = 'DUPLICATE_MESSAGE';
}
/** Banco/SQS indisponível, timeout de lock, deadlock: seguro tentar de novo. */
export class TransientInfrastructureError extends Error {
  readonly code = 'TRANSIENT_INFRASTRUCTURE';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
