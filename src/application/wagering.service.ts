import { Inject, Injectable, Optional } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { DomainError, ValidationError } from '../domain/errors';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import { computePayloadHash } from '../domain/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { InboxRepository } from '../infrastructure/persistence/inbox.repository';
import { describeDbError, isLockTimeout, isTransientDbError, isUniqueViolation } from '../infrastructure/persistence/pg-errors';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import {
  DuplicateMessageError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
  type SubmitWagerTransactionCommand,
  type WagerTransactionResult,
  type WagerTransactionView,
} from './dto';
import { APP_LOGGER, CLOCK, METRICS, type AppLogger, type Clock, type Metrics } from './ports';
import { WagerEngine } from './wager-engine';

/** Lock de linha preso por mais que isso vira erro transitório (55P03) em vez de pendurar a requisição. */
export const LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`;
/** Espera pelo lock da wallet acima disso conta como "conflito de lock" na métrica. */
const LOCK_CONFLICT_THRESHOLD_MS = 50;
/** Corridas de unicidade se resolvem na 2ª leitura; o limite só protege contra laço infinito. */
const MAX_RACE_ATTEMPTS = 3;

const UQ_IDEMPOTENCY = 'uq_wtx_idempotency_key';
const UQ_PROVIDER_EXTERNAL = 'uq_wtx_provider_external';
const UQ_SINGLE_REVERSAL = 'uq_wtx_single_reversal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const systemClock: Clock = { now: () => new Date() };

interface ParsedCommand {
  kind: WagerTransactionKind;
  money: Money;
  walletId: string;
  playerId: string;
  payloadHash: string;
}

/** Caso de uso único das entradas HTTP e SQS. */
@Injectable()
export class WageringService {
  private readonly clock: Clock;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(InboxRepository) private readonly inbox: InboxRepository,
    @Inject(WagerEngine) private readonly engine: WagerEngine,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Algoritmo (tudo em UMA transação SQL, ver ARCHITECTURE.md):
   *  1. inbox (SQS)  2. wallet FOR UPDATE  3. lookup de idempotência  4. regras + escritas.
   *
   * Por que a wallet é travada ANTES do lookup de idempotência: o lock serializa todo o tráfego da wallet, então
   * "existe?" e "insere" não se intercalam com outra requisição da mesma wallet, e o saldo lido já é o definitivo.
   * Só a corrida entre wallets diferentes com a mesma chave escapa do lock — essa é decidida pelos índices únicos.
   */
  async submit(cmd: SubmitWagerTransactionCommand): Promise<WagerTransactionResult> {
    const started = performance.now();
    const source = cmd.inbox ? 'sqs' : 'http';
    const parsed = this.parse(cmd); // ValidationError: nada é persistido

    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await this.runOnce(cmd, parsed, source);
          this.metrics.processingLatency((performance.now() - started) / 1000, source);
          return result;
        } catch (e) {
          if (!this.isRace(e)) throw e;
          if (attempt >= MAX_RACE_ATTEMPTS) {
            throw new TransientInfrastructureError('unique-constraint race did not settle, retry later', e);
          }
          // A transação perdedora foi revertida. A releitura (nova transação) enxerga a vencedora já comitada e
          // devolve replay, conflito de idempotência ou REJECTED REFERENCE_ALREADY_REVERSED.
          this.logger.debug('unique race, re-reading', { correlationId: cmd.correlationId, providerId: cmd.providerId });
        }
      }
    } catch (e) {
      throw this.mapError(e, cmd);
    }
  }

  async getById(transactionId: string): Promise<WagerTransactionView> {
    if (!UUID.test(transactionId)) throw new NotFoundError('transaction not found');
    const tx = await this.read(() => this.transactions.findById(this.orm.em.fork(), transactionId.toLowerCase()));
    if (!tx) throw new NotFoundError('transaction not found');
    return toView(tx);
  }

  async getByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.read(() =>
      this.transactions.findByProviderExternal(this.orm.em.fork(), providerId, externalTransactionId),
    );
    if (!tx) throw new NotFoundError('transaction not found');
    return toView(tx);
  }

  private async runOnce(cmd: SubmitWagerTransactionCommand, parsed: ParsedCommand, source: 'http' | 'sqs'): Promise<WagerTransactionResult> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(LOCK_TIMEOUT_SQL);

      if (cmd.inbox) {
        const received = InboxMessage.receive({
          messageId: cmd.inbox.messageId,
          consumerName: cmd.inbox.consumerName,
          payloadHash: parsed.payloadHash,
          receivedAt: this.clock.now(),
        });
        received.markProcessed(received.receivedAt); // comitar esta transação É processar a mensagem
        if (!(await this.inbox.tryInsert(em, received))) {
          throw new DuplicateMessageError(`message ${cmd.inbox.messageId} already processed`);
        }
      }

      const lockStarted = performance.now();
      const wallet = await this.wallets.lockById(em, parsed.walletId);
      if (performance.now() - lockStarted > LOCK_CONFLICT_THRESHOLD_MS) this.metrics.lockConflict();

      // Releitura sempre DEPOIS do lock e dentro da transação: em READ COMMITTED cada statement enxerga o que
      // as transações anteriores da wallet comitaram, inclusive o resultado de um PENDING_REFERENCE já resolvido.
      const byKey = await this.transactions.findByIdempotencyKey(em, cmd.idempotencyKey);
      if (byKey) {
        if (!byKey.matchesPayload(parsed.payloadHash)) {
          throw new IdempotencyConflictError('idempotency key was already used with a different payload');
        }
        if (!wallet) throw new WalletNotFoundError('wallet not found'); // inalcançável: hash igual => mesma wallet (FK)
        this.metrics.duplicateDetected(source);
        return toResult(byKey, wallet.balance, true);
      }
      if (!wallet) throw new WalletNotFoundError('wallet not found');

      const byExternal = await this.transactions.findByProviderExternal(em, cmd.providerId, cmd.externalTransactionId);
      if (byExternal) {
        throw new IdempotencyConflictError('provider transaction id was already used with a different idempotency key');
      }

      const now = this.clock.now(); // depois do lock: crescente por wallet
      const tx = this.createTransaction(cmd, parsed, now);
      await this.engine.settle(em, wallet, tx, { mode: 'insert', correlationId: cmd.correlationId, now });
      return toResult(tx, wallet.balance, false);
    });
  }

  /** Validação de entrada. Tudo que falha aqui é ValidationError e nunca chega ao banco. */
  private parse(cmd: SubmitWagerTransactionCommand): ParsedCommand {
    const text = (name: string, value: unknown, max: number): string => {
      if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
        throw new ValidationError(`${name} must be a non-empty string up to ${max} characters`);
      }
      return value;
    };
    const uuid = (name: string, value: unknown): string => {
      if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError(`${name} must be a UUID`);
      return value.toLowerCase();
    };

    text('idempotencyKey', cmd.idempotencyKey, 512);
    text('providerId', cmd.providerId, 128);
    text('externalTransactionId', cmd.externalTransactionId, 256);
    text('roundId', cmd.roundId, 512);
    text('gameId', cmd.gameId, 512);
    if (cmd.referenceExternalTransactionId !== undefined) {
      text('referenceExternalTransactionId', cmd.referenceExternalTransactionId, 256);
    }
    if (cmd.inbox) {
      text('inbox.messageId', cmd.inbox.messageId, 256);
      text('inbox.consumerName', cmd.inbox.consumerName, 256);
    }
    const walletId = uuid('walletId', cmd.walletId);
    const playerId = uuid('playerId', cmd.playerId);

    const kind = Object.values(WagerTransactionKind).find((k) => k === cmd.kind);
    if (kind === undefined || kind === WagerTransactionKind.Opening) {
      throw new ValidationError('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
    }
    const money = parseMoney(cmd.money);

    // O hash cobre só os campos de negócio, com o dinheiro normalizado ("25" == "25.00"). Header e metadados de
    // transporte (correlationId, inbox) ficam de fora de propósito.
    const payloadHash = computePayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId,
      walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    const parsed: ParsedCommand = { kind, money, walletId, playerId, payloadHash };
    this.createTransaction(cmd, parsed, this.clock.now()); // valida regras do agregado (ex.: BET com referência, valor 0)
    return parsed;
  }

  private createTransaction(cmd: SubmitWagerTransactionCommand, p: ParsedCommand, now: Date): WagerTransaction {
    return WagerTransaction.create({
      id: uuidv7(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: p.kind,
      money: p.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
  }

  private isRace(e: unknown): boolean {
    return (
      isUniqueViolation(e, UQ_IDEMPOTENCY) ||
      isUniqueViolation(e, UQ_PROVIDER_EXTERNAL) ||
      isUniqueViolation(e, UQ_SINGLE_REVERSAL)
    );
  }

  private mapError(e: unknown, cmd: SubmitWagerTransactionCommand): unknown {
    if (e instanceof DomainError || e instanceof TransientInfrastructureError) return e;
    if (isLockTimeout(e)) {
      this.metrics.lockConflict();
      this.metrics.retry('lock');
    }
    if (isTransientDbError(e)) {
      this.logger.warn('transient database failure', { correlationId: cmd.correlationId, providerId: cmd.providerId, ...describeDbError(e) });
      return new TransientInfrastructureError('transient database failure', e);
    }
    return e;
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isTransientDbError(e)) throw new TransientInfrastructureError('transient database failure', e);
      throw e;
    }
  }
}

function parseMoney(value: unknown): Money {
  if (typeof value !== 'object' || value === null) throw new ValidationError('money is required');
  try {
    return Money.from(value as MoneyProps);
  } catch (e) {
    if (e instanceof DomainError) throw new ValidationError(e.message);
    throw e;
  }
}

/** `walletBalance`: saldo atual, usado quando a transação não tem saldo-resultado próprio (PENDING_REFERENCE, FAILED). */
function toResult(tx: WagerTransaction, walletBalance: Money, idempotentReplay: boolean): WagerTransactionResult {
  const result: WagerTransactionResult = {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.resultBalance ?? walletBalance).toJSON(),
    idempotentReplay,
  };
  if (tx.failureCode !== undefined) result.failureCode = tx.failureCode;
  return result;
}

export function toView(tx: WagerTransaction): WagerTransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status as WagerTransactionStatus,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    resultBalance: tx.resultBalance?.toJSON() ?? null,
    attempts: tx.attempts,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
