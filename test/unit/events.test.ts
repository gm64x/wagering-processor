import { describe, it, expect } from 'bun:test';
import {
  FailureCode,
  LedgerDirection,
  Money,
  Wallet,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus as Status,
  WalletBalanceChanged,
  type EventContext,
} from '../../src/domain/index';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ctx: EventContext = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  occurredAt: NOW,
};

function tx(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: money('10.00'),
    createdAt: NOW,
    ...overrides,
  });
}

describe('WagerTransactionProcessed', () => {
  it('envelope tem o formato esperado', () => {
    const event = WagerTransactionProcessed.from(tx(), money('90.00'), ctx);
    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      occurredAt: '2026-10-25T12:00:00.000Z',
      data: {
        transactionId: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'round-1',
        kind: Kind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
        balance: { amount: '90.00', currency: 'BRL' },
      },
    });
  });

  it('aggregateId é o walletId e version é 1', () => {
    const event = WagerTransactionProcessed.from(tx(), money('1.00'), ctx);
    expect(event.aggregateId).toBe('w-1');
    expect(event.version).toBe(1);
    expect(event.eventType).toBe('WagerTransactionProcessed');
  });

  it('data guarda MoneyProps simples, nunca instâncias de Money', () => {
    const event = WagerTransactionProcessed.from(tx(), money('90.00'), ctx);
    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(event.data.balance).not.toBeInstanceOf(Money);
    expect(Object.getPrototypeOf(event.data.money)).toBe(Object.prototype);
  });

  it('data é congelado, inclusive objetos aninhados', () => {
    const event = WagerTransactionProcessed.from(tx(), money('90.00'), ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => {
      (event.data as { roundId: string }).roundId = 'hacked';
    }).toThrow();
  });

  it('JSON.stringify produz o envelope do toJSON', () => {
    const event = WagerTransactionProcessed.from(tx(), money('90.00'), ctx);
    expect(JSON.parse(JSON.stringify(event))).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
  });

  it('omite causationId quando ausente e o inclui quando informado', () => {
    const without = WagerTransactionProcessed.from(tx(), money('1.00'), ctx).toJSON();
    expect('causationId' in without).toBe(false);

    const withCause = WagerTransactionProcessed.from(tx(), money('1.00'), {
      ...ctx,
      causationId: 'cmd-9',
    }).toJSON();
    expect(withCause.causationId).toBe('cmd-9');
  });
});

describe('WagerTransactionRejected', () => {
  it('inclui failureCode e balance', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, money('5.00'), NOW);
    const json = WagerTransactionRejected.from(t, money('5.00'), ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w-1');
    expect(json.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'round-1',
      kind: Kind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: '5.00', currency: 'BRL' },
    });
  });

  it('é congelado e não carrega instâncias de Money', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, money('5.00'), NOW);
    const event = WagerTransactionRejected.from(t, money('5.00'), ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(event.data.balance).not.toBeInstanceOf(Money);
  });

  it('não constrói sem failure code', () => {
    expect(() => WagerTransactionRejected.from(tx(), money('5.00'), ctx)).toThrow();
  });
});

describe('WagerTransactionPendingReference', () => {
  it('serializa a referência e as informações de retry', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    t.markPendingReference(new Date('2026-10-25T12:00:01.000Z'));
    const json = WagerTransactionPendingReference.from(t, ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w-1');
    expect(json.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'w-1',
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext-bet',
      attempts: 1,
      nextAttemptAt: '2026-10-25T12:00:01.000Z',
    });
  });

  it('usa null para referência e nextAttemptAt ausentes', () => {
    const t = tx({ kind: Kind.Win, referenceExternalTransactionId: undefined });
    t.markPendingReference(NOW);
    const data = WagerTransactionPendingReference.from(t, ctx).data;
    expect(data.referenceExternalTransactionId).toBeNull();
    const untouched = WagerTransactionPendingReference.from(tx(), ctx).data;
    expect(untouched.nextAttemptAt).toBeNull();
    expect(untouched.attempts).toBe(0);
  });

  it('é congelado', () => {
    const t = tx({ kind: Kind.Win });
    expect(Object.isFrozen(WagerTransactionPendingReference.from(t, ctx).data)).toBe(true);
  });
});

describe('WalletBalanceChanged', () => {
  it('descreve uma movimentação do ledger na wallet', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: money('100.00'), now: NOW });
    const entry = wallet.debit({ entryId: 'le-1', transactionId: 'tx-1', money: money('30.00'), now: NOW });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w-1');
    expect(json.data).toEqual({
      walletId: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      walletVersion: 2,
      ledgerEntryId: 'le-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
    });
  });

  it('é congelado e não carrega instâncias de Money', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: money('1.00'), now: NOW });
    const entry = wallet.credit({ entryId: 'le', transactionId: 't', money: money('1.00'), now: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(event.data.balanceAfter).not.toBeInstanceOf(Money);
  });
});

describe('envelope de IntegrationEvent', () => {
  it('occurredAt é uma string ISO 8601', () => {
    const json = WagerTransactionProcessed.from(tx(), money('1.00'), ctx).toJSON();
    expect(typeof json.occurredAt).toBe('string');
    expect(new Date(json.occurredAt).toISOString()).toBe(json.occurredAt);
  });

  it('expõe o enum de status usado na transação processada', () => {
    const t = tx();
    t.markProcessed(undefined, money('90.00'), NOW);
    expect(t.status).toBe(Status.Processed);
  });
});
