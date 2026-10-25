import type { MoneyProps } from '../money';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger-entry';
import type { Wallet } from '../wallet';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  currency: string;
  walletVersion: number;
  ledgerEntryId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = 'WalletBalanceChanged' as const;
  override readonly version = 1 as const;

  private constructor(ctx: EventContext, data: WalletBalanceChangedData) {
    super(ctx, data.walletId, data);
  }

  /** Chamar logo após `wallet.debit/credit`, usando o lançamento devolvido. */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(ctx, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      walletVersion: wallet.version,
      ledgerEntryId: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
    });
  }
}
