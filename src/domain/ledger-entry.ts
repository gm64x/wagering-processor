import { CurrencyMismatchError, type Money } from './money';
import { InvalidLedgerEntryError } from './errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Lançamento do ledger da wallet. Append-only: não há métodos de mutação. */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  static create(p: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    createdAt: Date;
  }): WalletLedgerEntry {
    if (p.money.currency !== p.balanceBefore.currency) {
      throw new CurrencyMismatchError(p.money.currency, p.balanceBefore.currency);
    }
    if (!p.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger amount must be positive');
    }
    const balanceAfter =
      p.direction === LedgerDirection.Credit
        ? p.balanceBefore.add(p.money)
        : p.balanceBefore.subtract(p.money);
    if (balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger entry would leave a negative balance');
    }
    return new WalletLedgerEntry({
      id: p.id,
      walletId: p.walletId,
      transactionId: p.transactionId,
      direction: p.direction,
      money: p.money,
      balanceBefore: p.balanceBefore,
      balanceAfter,
      createdAt: p.createdAt,
    });
  }

  /** Não valida: reconstrói o estado persistido tal como está. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s);
  }

  /** Verifica a aritmética balanceAfter = balanceBefore ± money e a moeda comum. */
  isBalanced(): boolean {
    const currency = this.money.currency;
    if (
      this.balanceBefore.currency !== currency ||
      this.balanceAfter.currency !== currency
    ) {
      return false;
    }
    if (!this.money.isPositive()) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
