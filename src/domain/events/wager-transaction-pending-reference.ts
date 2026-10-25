import type { WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference' as const;
  override readonly version = 1 as const;

  private constructor(ctx: EventContext, data: WagerTransactionPendingReferenceData) {
    super(ctx, data.walletId, data);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(ctx, {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      kind: tx.kind,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
    });
  }
}
