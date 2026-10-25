import type { WagerTransactionResult } from '../../application/dto';
import { WagerTransactionStatus } from '../../domain/wager-transaction';

/**
 * Status HTTP de POST /wagering/transactions a partir do resultado do use case.
 * - PROCESSED: 201 na primeira vez, 200 em replay idempotente;
 * - REJECTED: 422 (regra de negócio, corpo traz failureCode); replay mantém 422;
 * - PENDING_REFERENCE: 202 (aceito, aguarda referência); replay mantém 202;
 * - FAILED: 500 com o corpo do resultado (erro permanente auditável).
 */
export function submitStatusCode(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
  }
}
