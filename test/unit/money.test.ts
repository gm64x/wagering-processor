import { describe, it, expect } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainError,
  InvalidMoneyError,
  Money,
} from '../../src/domain/index';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('parsing de Money.from', () => {
  it.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0.00', '0.00'],
    ['1000.00', '1000.00'],
    ['0.1', '0.10'],
    ['0', '0.00'],
    ['12345678901234567890.12', '12345678901234567890.12'],
  ])('aceita %s e normaliza para %s', (input, normalized) => {
    expect(brl(input).amount).toBe(normalized);
    expect(brl(input).toJSON()).toEqual({ amount: normalized, currency: 'BRL' });
  });

  it.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e5',
    '',
    '1.234',
    '-1.00',
    ' 1.00',
    '1.00 ',
    '01.00',
    'abc',
    '+1',
    '1.',
    '.5',
    '1,00',
  ])('rejeita %j', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  it('rejeita valor que não é string, como número JS', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each(['br', 'brl', 'BRLX', '', 'B1L'])('rejeita moeda inválida %j', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('InvalidMoneyError é um DomainError com código estável', () => {
    try {
      brl('1e5');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('INVALID_MONEY');
    }
  });
});

describe('Money.fromPersisted', () => {
  it('aceita a saída numeric(20,2) do Postgres', () => {
    expect(Money.fromPersisted('25.00', 'BRL').amount).toBe('25.00');
    expect(Money.fromPersisted('0.00', 'BRL').isZero()).toBe(true);
  });

  it('não valida o sinal', () => {
    const m = Money.fromPersisted('-5.00', 'BRL');
    expect(m.isNegative()).toBe(true);
    expect(m.amount).toBe('-5.00');
  });

  it('rejeita strings malformadas', () => {
    expect(() => Money.fromPersisted('abc', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.fromPersisted('1e5', 'BRL')).toThrow(InvalidMoneyError);
  });
});

describe('aritmética de Money', () => {
  it('é exata: 0.10 + 0.20 resulta em 0.30', () => {
    const sum = brl('0.10').add(brl('0.20'));
    expect(sum.amount).toBe('0.30');
    expect(sum.equals(brl('0.30'))).toBe(true);
  });

  it('mantém a exatidão além da precisão de Number', () => {
    const sum = brl('99999999999999999.99').add(brl('0.01'));
    expect(sum.amount).toBe('100000000000000000.00');
  });

  it('subtrai e pode ficar negativo internamente', () => {
    expect(brl('10.00').subtract(brl('25.50')).amount).toBe('-15.50');
    expect(brl('10.00').subtract(brl('10.00')).isZero()).toBe(true);
  });

  it('negate gera valor negativo com o sinal na string de saída', () => {
    const neg = brl('25').negate();
    expect(neg.amount).toBe('-25.00');
    expect(neg.toString()).toBe('-25.00 BRL');
    expect(neg.negate().equals(brl('25'))).toBe(true);
    expect(brl('0.00').negate().amount).toBe('0.00');
  });

  it('predicados de sinal', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('1.00').negate().isNegative()).toBe(true);
  });

  it('isLessThan compara valores', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  it('zero cria um valor zero', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });
});

describe('moedas divergentes em Money', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  it('add lança CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
  });

  it('subtract lança CurrencyMismatchError', () => {
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
  });

  it('isLessThan lança CurrencyMismatchError', () => {
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('equals retorna false entre moedas em vez de lançar erro', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  it('CurrencyMismatchError tem código estável', () => {
    try {
      brl('1.00').add(usd);
    } catch (err) {
      expect((err as DomainError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

describe('imutabilidade de Money', () => {
  it('instâncias são congeladas', () => {
    const m = brl('1.00');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
    expect(() => {
      (m as unknown as { minor: bigint }).minor = 999n;
    }).toThrow();
    expect(m.amount).toBe('1.00');
  });

  it('operações retornam novas instâncias e não alteram os operandos', () => {
    const a = brl('1.00');
    const b = brl('2.00');
    const c = a.add(b);
    expect(c).not.toBe(a);
    expect(a.amount).toBe('1.00');
    expect(b.amount).toBe('2.00');
  });
});

describe('serialização de Money', () => {
  it('JSON.stringify usa o formato de MoneyProps', () => {
    expect(JSON.parse(JSON.stringify(brl('25.5')))).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  it('toString é "<amount> <currency>"', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
