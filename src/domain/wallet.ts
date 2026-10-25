import { DomainError, ValidationError } from './errors';
import { CurrencyMismatchError, type Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends DomainError {
  override readonly code = 'INSUFFICIENT_FUNDS';
}

/** Saldo de um jogador em uma moeda. Toda mudança de saldo gera um WalletLedgerEntry. */
export class Wallet {
  private state: WalletState;

  private constructor(state: WalletState) {
    this.state = state;
  }

  static open(p: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (p.initialBalance.isNegative()) {
      throw new ValidationError('initial balance cannot be negative');
    }
    return new Wallet({
      id: p.id,
      playerId: p.playerId,
      currency: p.initialBalance.currency,
      balance: p.initialBalance,
      version: 1,
      createdAt: p.now,
      updatedAt: p.now,
    });
  }

  /** Não valida: reconstrói o estado persistido tal como está. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet({ ...s });
  }

  get id(): string {
    return this.state.id;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get currency(): string {
    return this.state.currency;
  }

  get balance(): Money {
    return this.state.balance;
  }

  get version(): number {
    return this.state.version;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  debit(p: { entryId: string; transactionId: string; money: Money; now: Date }): WalletLedgerEntry {
    this.assertCurrency(p.money);
    if (!this.canDebit(p.money)) {
      throw new InsufficientFundsError(
        `wallet ${this.state.id} has ${this.state.balance.toString()}, cannot debit ${p.money.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, p);
  }

  credit(p: { entryId: string; transactionId: string; money: Money; now: Date }): WalletLedgerEntry {
    this.assertCurrency(p.money);
    return this.apply(LedgerDirection.Credit, p);
  }

  canDebit(money: Money): boolean {
    return money.currency === this.state.currency && !this.state.balance.isLessThan(money);
  }

  toState(): WalletState {
    return { ...this.state };
  }

  /**
   * Cria o lançamento primeiro (ele valida sinal, moeda e saldo final) e só então muda o estado,
   * para que uma falha nunca deixe saldo, versão e ledger divergentes.
   */
  private apply(
    direction: LedgerDirection,
    p: { entryId: string; transactionId: string; money: Money; now: Date },
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.state.id,
      transactionId: p.transactionId,
      direction,
      money: p.money,
      balanceBefore: this.state.balance,
      createdAt: p.now,
    });
    this.state.balance = entry.balanceAfter;
    this.state.version += 1;
    this.state.updatedAt = p.now;
    return entry;
  }

  private assertCurrency(money: Money): void {
    if (money.currency !== this.state.currency) {
      throw new CurrencyMismatchError(this.state.currency, money.currency);
    }
  }
}
