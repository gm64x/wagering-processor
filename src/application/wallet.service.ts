import { Inject, Injectable, Optional } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { DomainError, ValidationError } from '../domain/errors';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { LedgerRepository } from '../infrastructure/persistence/ledger.repository';
import { OutboxRepository } from '../infrastructure/persistence/outbox.repository';
import { isTransientDbError, isUniqueViolation } from '../infrastructure/persistence/pg-errors';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import {
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  type CreateWalletCommand,
  type LedgerPage,
  type ReconciliationReport,
  type WalletView,
} from './dto';
import { APP_LOGGER, CLOCK, METRICS, type AppLogger, type Clock, type Metrics } from './ports';
import { LOCK_TIMEOUT_SQL, systemClock } from './wagering.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DIGITS = /^\d{1,18}$/;

export const encodeCursor = (seq: string): string => Buffer.from(seq, 'utf8').toString('base64url');

export function decodeCursor(cursor: string): string {
  const seq = Buffer.from(cursor, 'base64url').toString('utf8');
  // re-codificar descarta lixo que o decoder tolerou; só dígitos entram na query
  if (!DIGITS.test(seq) || encodeCursor(seq) !== cursor) throw new ValidationError('invalid cursor');
  return seq;
}

@Injectable()
export class WalletService {
  private readonly clock: Clock;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(LedgerRepository) private readonly ledgers: LedgerRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Wallet + (se saldo inicial > 0) transação interna OPENING + lançamento CREDIT + eventos, numa única transação SQL.
   * A wallet nasce com version 1 já com o saldo inicial; o crédito de abertura não incrementa a versão.
   */
  async create(cmd: CreateWalletCommand): Promise<WalletView> {
    if (typeof cmd.playerId !== 'string' || !UUID.test(cmd.playerId)) throw new ValidationError('playerId must be a UUID');
    const playerId = cmd.playerId.toLowerCase();
    const initialBalance = parseMoney(cmd.initialBalance);

    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(LOCK_TIMEOUT_SQL);
        const now = this.clock.now();
        const wallet = Wallet.open({ id: uuidv7(), playerId, initialBalance, now });
        // A unicidade (player_id, currency) é garantida pelo schema: a violação vira WalletAlreadyExistsError abaixo.
        await this.wallets.insert(em, wallet);

        if (initialBalance.isPositive()) {
          const events = await this.recordOpening(em, wallet, initialBalance, cmd.correlationId, now);
          await this.outbox.insertMany(em, events.map((event) => OutboxMessage.enqueue(event, now)));
          this.metrics.transactionsTotal('PROCESSED', WagerTransactionKind.Opening);
        }
        return toWalletView(wallet);
      });
    } catch (e) {
      if (isUniqueViolation(e, 'uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError('a wallet already exists for this player and currency');
      }
      throw this.mapTransient(e);
    }
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = UUID.test(walletId) ? await this.read(() => this.wallets.findById(this.orm.em.fork(), walletId.toLowerCase())) : null;
    if (!wallet) throw new WalletNotFoundError('wallet not found');
    return toWalletView(wallet);
  }

  /** Paginação por cursor opaco = base64url(seq do último item). Ordem estável: seq ASC (ordem de commit do lançamento). */
  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterSeq = cursor === undefined || cursor === '' ? undefined : decodeCursor(cursor);
    const pageSize = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
    await this.get(walletId);

    const records = await this.read(() =>
      this.ledgers.pageByWallet(this.orm.em.fork(), walletId.toLowerCase(), afterSeq, pageSize + 1),
    );
    const page = records.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: records.length > pageSize && last ? encodeCursor(last.seq) : null,
    };
  }

  /**
   * Compara o saldo armazenado com SUM(créditos) - SUM(débitos) do ledger e com o balance_after do último
   * lançamento. Divergência é logada, contada em métrica e sinalizada na resposta; NUNCA é corrigida aqui.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const snapshot = UUID.test(walletId)
      ? await this.read(() => this.ledgers.reconciliationSnapshot(this.orm.em.fork(), walletId.toLowerCase()))
      : null;
    if (!snapshot) throw new WalletNotFoundError('wallet not found');

    const { storedBalance, calculatedBalance, lastBalanceAfter, entries } = snapshot;
    const lastMatches = lastBalanceAfter === undefined ? storedBalance.isZero() : lastBalanceAfter.equals(storedBalance);
    const consistent = storedBalance.equals(calculatedBalance) && lastMatches;

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence', { correlationId, walletId, checkedEntries: entries });
    }
    return {
      walletId: walletId.toLowerCase(),
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: storedBalance.subtract(calculatedBalance).toJSON(),
      consistent,
      checkedEntries: entries,
    };
  }

  private async recordOpening(
    em: Parameters<WalletRepository['insert']>[0],
    wallet: Wallet,
    initialBalance: Money,
    correlationId: string,
    now: Date,
  ): Promise<IntegrationEvent<unknown>[]> {
    const walletId = wallet.id;
    const externalId = `opening:${walletId}`;
    const payloadHash = computePayloadHash({
      providerId: 'internal',
      externalTransactionId: externalId,
      playerId: wallet.playerId,
      walletId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: initialBalance.toJSON(),
    });
    const tx = WagerTransaction.create({
      id: uuidv7(),
      providerId: 'internal',
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      payloadHash,
      walletId,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: now,
      allowInternal: true,
    });
    tx.markProcessed(undefined, wallet.balance, now);
    const entry = WalletLedgerEntry.create({
      id: uuidv7(),
      walletId,
      transactionId: tx.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      createdAt: now,
    });

    await this.transactions.insert(em, tx, correlationId); // FK: antes do ledger
    await this.ledgers.insert(em, entry);

    const ctx = (): EventContext => ({ eventId: uuidv7(), correlationId, causationId: tx.id, occurredAt: now });
    return [WagerTransactionProcessed.from(tx, wallet.balance, ctx()), WalletBalanceChanged.from(wallet, entry, ctx())];
  }

  private mapTransient(e: unknown): unknown {
    if (e instanceof DomainError || e instanceof TransientInfrastructureError) return e;
    return isTransientDbError(e) ? new TransientInfrastructureError('transient database failure', e) : e;
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.mapTransient(e);
    }
  }
}

function parseMoney(value: unknown): Money {
  if (typeof value !== 'object' || value === null) throw new ValidationError('initialBalance is required');
  try {
    return Money.from(value as MoneyProps);
  } catch (e) {
    if (e instanceof DomainError) throw new ValidationError(e.message);
    throw e;
  }
}

function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
