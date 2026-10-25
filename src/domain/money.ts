import { DomainError } from './errors';

/** Representação externa de dinheiro: amount decimal em string, currency ISO-4217 de 3 letras. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Entrada: não negativa, até 2 casas decimais, sem sinal, sem notação científica, sem espaços. */
const AMOUNT_INPUT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
/** Valor vindo do Postgres (numeric(20,2)): sinal não é validado aqui. */
const AMOUNT_PERSISTED = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  override readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  override readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`currency mismatch: ${left} vs ${right}`);
  }
}

/**
 * Valor monetário imutável. Internamente é um bigint de centavos (escala fixa 2),
 * então somas e subtrações são exatas. Nunca usar number para valores monetários.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount must be a string');
    }
    assertCurrency(props.currency);
    if (!AMOUNT_INPUT.test(props.amount)) {
      throw new InvalidMoneyError(`invalid amount: ${JSON.stringify(props.amount)}`);
    }
    return new Money(toMinor(props.amount), props.currency);
  }

  static fromPersisted(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !AMOUNT_PERSISTED.test(amount)) {
      throw new InvalidMoneyError(`invalid persisted amount: ${JSON.stringify(amount)}`);
    }
    assertCurrency(currency);
    return new Money(toMinor(amount), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Igualdade por valor e moeda. Moedas diferentes resultam em `false`, sem erro. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  get amount(): string {
    return formatMinor(this.minor);
  }

  toJSON(): MoneyProps {
    return { amount: formatMinor(this.minor), currency: this.currency };
  }

  toString(): string {
    return `${formatMinor(this.minor)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

function assertCurrency(currency: string): void {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError(`invalid currency: ${JSON.stringify(currency)}`);
  }
}

/** Converte "-?\d+(\.\d{1,2})?" para centavos. A validação é responsabilidade do chamador. */
function toMinor(text: string): bigint {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -minor : minor;
}

function formatMinor(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole.toString()}.${fraction}`;
}
