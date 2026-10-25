import { InvalidTransactionStateError, ValidationError } from './errors';
import { FailureCode } from './failure-codes';
import { LedgerDirection } from './ledger-entry';
import type { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  /** Só true para OPENING criado pelo WalletService. */
  allowInternal?: boolean;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'allowInternal'> {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

function requiresReferenceKind(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

function acceptsReferenceKind(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback ||
    kind === WagerTransactionKind.Win ||
    kind === WagerTransactionKind.Loss
  );
}

export class WagerTransaction {
  private state: WagerTransactionState;

  private constructor(state: WagerTransactionState) {
    this.state = state;
  }

  static create(p: CreateWagerTransactionProps): WagerTransaction {
    const { allowInternal = false, ...base } = p;

    if (base.kind === WagerTransactionKind.Opening) {
      if (!allowInternal) {
        throw new ValidationError('OPENING transactions are internal only');
      }
      if (base.providerId !== 'internal') {
        throw new ValidationError('OPENING transactions must use providerId "internal"');
      }
    }

    const hasReference =
      typeof base.referenceExternalTransactionId === 'string' &&
      base.referenceExternalTransactionId.length > 0;
    if (requiresReferenceKind(base.kind) && !hasReference) {
      throw new ValidationError(`${base.kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && !acceptsReferenceKind(base.kind)) {
      throw new ValidationError(`${base.kind} does not accept referenceExternalTransactionId`);
    }

    if (base.kind === WagerTransactionKind.Loss) {
      if (base.money.isNegative()) {
        throw new ValidationError('LOSS amount cannot be negative');
      }
    } else if (!base.money.isPositive()) {
      throw new ValidationError(`${base.kind} amount must be positive`);
    }

    return new WagerTransaction({
      ...base,
      status: WagerTransactionStatus.Pending,
      attempts: 0,
    });
  }

  /** Não valida: reconstrói o estado persistido tal como está. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...s });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string {
    return this.state.roundId;
  }

  get gameId(): string {
    return this.state.gameId;
  }

  get kind(): WagerTransactionKind {
    return this.state.kind;
  }

  get money(): Money {
    return this.state.money;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt;
  }

  get resultBalance(): Money | undefined {
    return this.state.resultBalance;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this.state.status = WagerTransactionStatus.Processed;
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.resultBalance = resultBalance;
    this.state.processedAt = at;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal();
    this.state.status = WagerTransactionStatus.PendingReference;
    this.state.attempts += 1;
    this.state.nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, resultBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this.state.status = WagerTransactionStatus.Rejected;
    this.state.failureCode = code;
    this.state.resultBalance = resultBalance;
    this.state.processedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();
    this.state.status = WagerTransactionStatus.Failed;
    this.state.failureCode = code;
    this.state.processedAt = at;
  }

  isTerminal(): boolean {
    const s = this.state.status;
    return (
      s === WagerTransactionStatus.Processed ||
      s === WagerTransactionStatus.Rejected ||
      s === WagerTransactionStatus.Failed
    );
  }

  /** LOSS não move saldo; todos os demais movem. */
  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReferenceKind(this.state.kind);
  }

  acceptsReference(): boolean {
    return acceptsReferenceKind(this.state.kind);
  }

  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }

  allowedReferenceKinds(): WagerTransactionKind[] {
    switch (this.state.kind) {
      case WagerTransactionKind.Refund:
        return [WagerTransactionKind.Bet];
      case WagerTransactionKind.Rollback:
        return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return [WagerTransactionKind.Bet];
      default:
        return [];
    }
  }

  /**
   * Direção do lançamento no ledger da wallet. ROLLBACK depende da referência:
   * desfaz o efeito dela, então inverte a direção da referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new ValidationError('ROLLBACK requires a reference to determine ledger direction');
        }
        if (!this.allowedReferenceKinds().includes(reference.kind)) {
          throw new ValidationError(`ROLLBACK cannot reverse a ${reference.kind} transaction`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new ValidationError('LOSS does not move balance and has no ledger direction');
    }
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `wager transaction ${this.state.id} is terminal (${this.state.status})`,
      );
    }
  }
}
