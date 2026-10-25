import { describe, it, expect } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainError,
  LedgerDirection,
  Money,
  WalletLedgerEntry,
} from '../../src/domain/index';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const NOW = new Date('2026-10-25T12:00:00.000Z');

function entry(direction: LedgerDirection, before: string, amount: string) {
  return WalletLedgerEntry.create({
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    direction,
    money: brl(amount),
    balanceBefore: brl(before),
    createdAt: NOW,
  });
}

describe('aritmética de WalletLedgerEntry.create', () => {
  it('CREDIT: balanceAfter é balanceBefore + money', () => {
    const e = entry(LedgerDirection.Credit, '10.00', '2.50');
    expect(e.balanceAfter.amount).toBe('12.50');
    expect(e.isBalanced()).toBe(true);
  });

  it('DEBIT: balanceAfter é balanceBefore - money', () => {
    const e = entry(LedgerDirection.Debit, '10.00', '2.50');
    expect(e.balanceAfter.amount).toBe('7.50');
    expect(e.isBalanced()).toBe(true);
  });

  it('DEBIT até zero exato é permitido', () => {
    expect(entry(LedgerDirection.Debit, '10.00', '10.00').balanceAfter.isZero()).toBe(true);
  });

  it('mantém todos os campos informados e os expõe', () => {
    const e = entry(LedgerDirection.Credit, '0.00', '1.00');
    expect(e.id).toBe('e-1');
    expect(e.walletId).toBe('w-1');
    expect(e.transactionId).toBe('t-1');
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.money.amount).toBe('1.00');
    expect(e.balanceBefore.amount).toBe('0.00');
    expect(e.createdAt).toEqual(NOW);
  });

  it('é exata em somas de centavos', () => {
    expect(entry(LedgerDirection.Credit, '0.10', '0.20').balanceAfter.amount).toBe('0.30');
  });

  it('rejeita valor zero', () => {
    expect(() => entry(LedgerDirection.Credit, '10.00', '0.00')).toThrow(DomainError);
  });

  it('rejeita valor negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('1.00').negate(),
        balanceBefore: brl('10.00'),
        createdAt: NOW,
      }),
    ).toThrow(DomainError);
  });

  it('rejeita DEBIT que deixaria o saldo negativo', () => {
    expect(() => entry(LedgerDirection.Debit, '10.00', '10.01')).toThrow(DomainError);
  });

  it('rejeita moedas divergentes com CurrencyMismatchError', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: usd('1.00'),
        balanceBefore: brl('10.00'),
        createdAt: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('erros de invariante carregam código estável', () => {
    try {
      entry(LedgerDirection.Debit, '1.00', '2.00');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_LEDGER_ENTRY');
    }
  });
});

describe('imutabilidade de WalletLedgerEntry', () => {
  it('instâncias são congeladas e os campos não podem ser reatribuídos', () => {
    const e = entry(LedgerDirection.Credit, '1.00', '1.00');
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { money: Money }).money = brl('99.00');
    }).toThrow();
    expect(() => {
      (e as unknown as { id: string }).id = 'other';
    }).toThrow();
    expect(e.money.amount).toBe('1.00');
  });
});

describe('WalletLedgerEntry.isBalanced e rehydrate', () => {
  it('rehydrate não valida: entrada inconsistente é apontada por isBalanced', () => {
    const e = WalletLedgerEntry.rehydrate({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Debit,
      money: brl('2.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('9.00'),
      createdAt: NOW,
    });
    expect(e.isBalanced()).toBe(false);
  });

  it('entrada consistente reidratada fica balanceada', () => {
    const e = WalletLedgerEntry.rehydrate({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Credit,
      money: brl('2.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('12.00'),
      createdAt: NOW,
    });
    expect(e.isBalanced()).toBe(true);
  });

  it('isBalanced é false quando as moedas divergem', () => {
    const e = WalletLedgerEntry.rehydrate({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Credit,
      money: usd('2.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('12.00'),
      createdAt: NOW,
    });
    expect(e.isBalanced()).toBe(false);
  });
});
