import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { FailureCode } from '../domain/failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wager-transaction';
import type { Money } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import { OutboxMessage } from '../domain/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { LedgerRepository } from '../infrastructure/persistence/ledger.repository';
import { OutboxRepository } from '../infrastructure/persistence/outbox.repository';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import { METRICS, type Metrics } from './ports';

export interface SettleOptions {
  /** 'insert': transação nova (grava a linha). 'update': PENDING_REFERENCE existente (worker). */
  mode: 'insert' | 'update';
  correlationId: string;
  now: Date;
  /** Só o worker: com `attempts >= maxAttempts` e referência ainda ausente, rejeita REFERENCE_NOT_FOUND. */
  maxAttempts?: number;
}

const MAX_BACKOFF_MS = 60_000;

/** Backoff exponencial: base * 2^(attempts-1), limitado a 60s. `attempts` já contando a tentativa em curso. */
export function pendingReferenceDelayMs(baseDelayMs: number, attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(baseDelayMs * 2 ** exponent, MAX_BACKOFF_MS);
}

/**
 * Regras de negócio da seção 7, aplicadas a uma transação PENDING (nova) ou PENDING_REFERENCE (worker)
 * COM A WALLET JÁ TRAVADA (SELECT ... FOR UPDATE) pelo chamador, dentro da transação SQL dele.
 * É o único lugar que decide o estado final e grava transação, saldo, ledger e outbox — assim o caminho
 * HTTP/SQS e o worker de referências pendentes não podem divergir.
 */
@Injectable()
export class WagerEngine {
  private readonly baseDelayMs = positiveIntEnv('PENDING_REF_BASE_DELAY_MS', 1000);

  constructor(
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(LedgerRepository) private readonly ledger: LedgerRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /**
   * Muta `wallet` e `tx` (domínio) e persiste tudo na transação `em`. Ordem das escritas:
   * transação -> wallet -> ledger -> outbox (a violação de unicidade da transação, a mais provável, falha primeiro
   * e barato; o ledger referencia a transação por FK).
   */
  async settle(em: EntityManager, wallet: Wallet, tx: WagerTransaction, opts: SettleOptions): Promise<void> {
    const wasPendingReference = tx.status === WagerTransactionStatus.PendingReference;
    const versionBefore = wallet.version;
    const entry = await this.evaluate(em, wallet, tx, opts);

    if (opts.mode === 'insert') {
      await this.transactions.insert(em, tx, opts.correlationId);
    } else {
      await this.transactions.update(em, tx, opts.now);
    }
    if (entry) {
      await this.wallets.updateBalance(em, wallet, versionBefore);
      await this.ledger.insert(em, entry);
    }

    const events = this.eventsFor(wallet, tx, entry, opts, wasPendingReference);
    await this.outbox.insertMany(em, events.map((event) => OutboxMessage.enqueue(event, opts.now)));

    // Re-agendamentos do worker não são "transações novas": só estados que o provedor/consumidores observam contam.
    if (opts.mode === 'insert' || tx.isTerminal()) {
      this.metrics.transactionsTotal(tx.status, tx.kind);
    }
  }

  /** Decide o estado final de `tx`. Devolve o lançamento de ledger quando o saldo se move. */
  private async evaluate(em: EntityManager, wallet: Wallet, tx: WagerTransaction, opts: SettleOptions): Promise<WalletLedgerEntry | undefined> {
    const { now } = opts;
    const reject = (code: FailureCode): undefined => {
      tx.reject(code, wallet.balance, now);
      return undefined;
    };

    if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const found = await this.transactions.findByProviderExternal(em, tx.providerId, tx.referenceExternalTransactionId);

      // Atributos imutáveis da referência: se divergem, nunca vão passar a coincidir -> rejeita já,
      // mesmo que a referência ainda esteja pendente.
      if (
        found &&
        (found.walletId !== tx.walletId ||
          found.playerId !== tx.playerId ||
          found.money.currency !== tx.money.currency ||
          found.roundId !== tx.roundId)
      ) {
        return reject(FailureCode.ReferenceMismatch);
      }
      if (found && !tx.allowedReferenceKinds().includes(found.kind)) {
        return reject(FailureCode.ReferenceInvalidKind);
      }
      if (found && (found.status === WagerTransactionStatus.Rejected || found.status === WagerTransactionStatus.Failed)) {
        return reject(FailureCode.ReferenceNotProcessed);
      }
      if (!found || found.status !== WagerTransactionStatus.Processed) {
        // Referência ausente ou ainda em PENDING/PENDING_REFERENCE: espera (entrega fora de ordem).
        if (opts.maxAttempts !== undefined && tx.attempts >= opts.maxAttempts) {
          return reject(FailureCode.ReferenceNotFound);
        }
        const nextAttemptAt = new Date(now.getTime() + pendingReferenceDelayMs(this.baseDelayMs, tx.attempts + 1));
        tx.markPendingReference(nextAttemptAt);
        return undefined;
      }
      reference = found;

      if (tx.requiresReference()) {
        if (!tx.money.equals(reference.money)) return reject(FailureCode.AmountMismatch);
        // Checagem sob o lock da wallet (a referência é da mesma wallet, garantido acima). O índice parcial
        // uq_wtx_single_reversal continua sendo a garantia final no banco.
        if (await this.transactions.hasProcessedReversal(em, reference.id)) {
          return reject(FailureCode.ReferenceAlreadyReversed);
        }
      }
    }

    if (!tx.affectsBalance()) {
      // LOSS: registra o resultado sem mover saldo, sem ledger.
      tx.markProcessed(reference?.id, wallet.balance, now);
      return undefined;
    }

    const direction = tx.ledgerDirectionFor(reference);
    const entryId = uuidv7();
    if (direction === LedgerDirection.Debit) {
      if (!wallet.canDebit(tx.money)) {
        // BET sem saldo e ROLLBACK que deixaria saldo negativo são situações operacionais distintas.
        return reject(
          tx.kind === WagerTransactionKind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds,
        );
      }
      const entry = wallet.debit({ entryId, transactionId: tx.id, money: tx.money, now });
      tx.markProcessed(reference?.id, wallet.balance, now);
      return entry;
    }
    const entry = wallet.credit({ entryId, transactionId: tx.id, money: tx.money, now });
    tx.markProcessed(reference?.id, wallet.balance, now);
    return entry;
  }

  /**
   * Eventos na ordem de emissão. Os eventIds são uuid v7 gerados em sequência (monotônicos), então
   * ORDER BY occurred_at, id preserva a ordem dentro da mesma transação.
   */
  private eventsFor(
    wallet: Wallet,
    tx: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    opts: SettleOptions,
    wasPendingReference: boolean,
  ): IntegrationEvent<unknown>[] {
    const ctx = (): EventContext => ({
      eventId: uuidv7(),
      correlationId: opts.correlationId,
      causationId: tx.id,
      occurredAt: opts.now,
    });
    const balance: Money = tx.resultBalance ?? wallet.balance;

    switch (tx.status) {
      case WagerTransactionStatus.Processed: {
        const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, balance, ctx())];
        if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx()));
        return events;
      }
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(tx, balance, ctx())];
      case WagerTransactionStatus.PendingReference:
        // Só a 1ª entrada em PENDING_REFERENCE é um fato novo; re-agendamentos do worker não geram evento.
        return wasPendingReference ? [] : [WagerTransactionPendingReference.from(tx, ctx())];
      default:
        return [];
    }
  }
}

export function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
