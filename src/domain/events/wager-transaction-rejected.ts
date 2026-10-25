import { ValidationError } from '../errors';
import type { MoneyProps, Money } from '../money';
import type { FailureCode } from '../failure-codes';
import type { WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected' as const;
  override readonly version = 1 as const;

  private constructor(ctx: EventContext, data: WagerTransactionRejectedData) {
    super(ctx, data.walletId, data);
  }

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionRejected {
    if (tx.failureCode === undefined) {
      throw new ValidationError(`rejected event requires a failureCode (transaction ${tx.id})`);
    }
    return new WagerTransactionRejected(ctx, {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      failureCode: tx.failureCode,
      balance: balance.toJSON(),
    });
  }
}
