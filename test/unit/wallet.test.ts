import { describe, it, expect } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  LedgerDirection,
  Money,
  Wallet,
} from '../../src/domain/index';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const NOW = new Date('2026-10-25T12:00:00.000Z');
const LATER = new Date('2026-10-25T12:05:00.000Z');

function openWallet(initial = '100.00'): Wallet {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), now: NOW });
}

describe('Wallet.open', () => {
  it('começa na versão 1 com o saldo e a moeda iniciais', () => {
    const w = openWallet('50.00');
    expect(w.id).toBe('w-1');
    expect(w.playerId).toBe('p-1');
    expect(w.currency).toBe('BRL');
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('50.00');
    expect(w.createdAt).toEqual(NOW);
    expect(w.updatedAt).toEqual(NOW);
  });

  it('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  it('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), now: NOW }),
    ).toThrow();
  });
});

describe('Wallet.debit', () => {
  it('reduz o saldo, incrementa a versão, define updatedAt e retorna uma entrada DEBIT', () => {
    const w = openWallet('100.00');
    const entry = w.debit({ entryId: 'e-1', transactionId: 't-1', money: brl('30.00'), now: LATER });

    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(LATER);
    expect(w.createdAt).toEqual(NOW);

    expect(entry.id).toBe('e-1');
    expect(entry.walletId).toBe('w-1');
    expect(entry.transactionId).toBe('t-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.money.amount).toBe('30.00');
    expect(entry.createdAt).toEqual(LATER);
    expect(entry.isBalanced()).toBe(true);
  });

  it('permite debitar o saldo exato até zero', () => {
    const w = openWallet('10.00');
    w.debit({ entryId: 'e', transactionId: 't', money: brl('10.00'), now: LATER });
    expect(w.balance.isZero()).toBe(true);
    expect(w.version).toBe(2);
  });

  it('lança InsufficientFundsError e mantém saldo e versão quando o saldo é insuficiente', () => {
    const w = openWallet('10.00');
    expect(() =>
      w.debit({ entryId: 'e', transactionId: 't', money: brl('10.01'), now: LATER }),
    ).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(NOW);
  });

  it('InsufficientFundsError tem código estável', () => {
    const w = openWallet('0.00');
    try {
      w.debit({ entryId: 'e', transactionId: 't', money: brl('0.01'), now: LATER });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InsufficientFundsError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  it('lança CurrencyMismatchError e não altera o estado', () => {
    const w = openWallet('10.00');
    expect(() =>
      w.debit({ entryId: 'e', transactionId: 't', money: usd('1.00'), now: LATER }),
    ).toThrow(CurrencyMismatchError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('rejeita debit zero sem alterar o estado', () => {
    const w = openWallet('10.00');
    expect(() =>
      w.debit({ entryId: 'e', transactionId: 't', money: brl('0.00'), now: LATER }),
    ).toThrow();
    expect(w.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  it('aumenta o saldo, incrementa a versão e retorna uma entrada CREDIT', () => {
    const w = openWallet('10.00');
    const entry = w.credit({ entryId: 'e-2', transactionId: 't-2', money: brl('5.25'), now: LATER });

    expect(w.balance.amount).toBe('15.25');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('10.00');
    expect(entry.balanceAfter.amount).toBe('15.25');
    expect(entry.isBalanced()).toBe(true);
  });

  it('cada movimentação incrementa a versão em exatamente um', () => {
    const w = openWallet('100.00');
    w.credit({ entryId: 'a', transactionId: 't1', money: brl('1.00'), now: LATER });
    w.debit({ entryId: 'b', transactionId: 't2', money: brl('2.00'), now: LATER });
    w.credit({ entryId: 'c', transactionId: 't3', money: brl('3.00'), now: LATER });
    expect(w.version).toBe(4);
    expect(w.balance.amount).toBe('102.00');
  });

  it('lança CurrencyMismatchError e não altera o estado', () => {
    const w = openWallet('10.00');
    expect(() =>
      w.credit({ entryId: 'e', transactionId: 't', money: usd('1.00'), now: LATER }),
    ).toThrow(CurrencyMismatchError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('rejeita crédito não positivo sem alterar o estado', () => {
    const w = openWallet('10.00');
    expect(() =>
      w.credit({ entryId: 'e', transactionId: 't', money: brl('0.00'), now: LATER }),
    ).toThrow();
    expect(w.version).toBe(1);
  });
});

describe('Wallet.canDebit', () => {
  it('é true quando o saldo cobre o valor, inclusive o saldo exato', () => {
    const w = openWallet('10.00');
    expect(w.canDebit(brl('10.00'))).toBe(true);
    expect(w.canDebit(brl('9.99'))).toBe(true);
  });

  it('é false quando o saldo é insuficiente ou a moeda diverge', () => {
    const w = openWallet('10.00');
    expect(w.canDebit(brl('10.01'))).toBe(false);
    expect(w.canDebit(usd('1.00'))).toBe(false);
  });
});

describe('estado de Wallet', () => {
  it('toState faz ida e volta pelo rehydrate', () => {
    const w = openWallet('42.00');
    w.debit({ entryId: 'e', transactionId: 't', money: brl('2.00'), now: LATER });
    const copy = Wallet.rehydrate(w.toState());
    expect(copy.balance.amount).toBe('40.00');
    expect(copy.version).toBe(2);
    expect(copy.updatedAt).toEqual(LATER);
  });

  it('rehydrate não valida o estado persistido', () => {
    const w = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('1.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(w.version).toBe(7);
  });
});
