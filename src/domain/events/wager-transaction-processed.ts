import type { MoneyProps, Money } from '../money';
import type { WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed' as const;
  override readonly version = 1 as const;

  private constructor(ctx: EventContext, data: WagerTransactionProcessedData) {
    super(ctx, data.walletId, data);
  }

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(ctx, {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      balance: balance.toJSON(),
    });
  }
}
