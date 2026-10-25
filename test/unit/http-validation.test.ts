import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../../src/domain/errors';
import {
  parseCreateWalletBody,
  parseIdempotencyKey,
  parseLimit,
  parseMoneyProps,
  parseOptionalCursor,
  parseSubmitWagerTransactionBody,
  requireOneOf,
  requireString,
  requireUuid,
  optionalString,
  SUBMITTABLE_KINDS,
} from '../../src/infrastructure/http/validation';

const UUID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

function expectValidation(fn: () => unknown, messagePart?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  if (messagePart !== undefined) {
    expect((caught as Error).message).toContain(messagePart);
  }
}

describe('requireString', () => {
  it('aceita string simples e a retorna sem alterações', () => {
    expect(requireString({ providerId: 'provider-a' }, 'providerId')).toBe('provider-a');
  });

  it('rejeita valores ausentes, null, que não são string, em branco ou com espaços nas bordas', () => {
    expectValidation(() => requireString({}, 'providerId'), 'is required');
    expectValidation(() => requireString({ providerId: null }, 'providerId'), 'is required');
    expectValidation(() => requireString({ providerId: 42 }, 'providerId'), 'must be a string');
    expectValidation(() => requireString({ providerId: ['a'] }, 'providerId'), 'must be a string');
    expectValidation(() => requireString({ providerId: '   ' }, 'providerId'), 'must not be empty');
    expectValidation(() => requireString({ providerId: ' a' }, 'providerId'), 'leading or trailing');
  });

  it('aplica o tamanho máximo (padrão 255)', () => {
    expect(requireString({ f: 'x'.repeat(255) }, 'f')).toHaveLength(255);
    expectValidation(() => requireString({ f: 'x'.repeat(256) }, 'f'), 'at most 255');
    expectValidation(() => requireString({ f: 'abcd' }, 'f', { max: 3 }), 'at most 3');
  });

  it('rejeita caracteres de controle', () => {
    expectValidation(() => requireString({ f: 'a\nb' }, 'f'), 'control characters');
    expectValidation(() => requireString({ f: 'a\u0000b' }, 'f'), 'control characters');
  });

  it('rejeita container que não é objeto', () => {
    expectValidation(() => requireString(undefined, 'f'), 'must be a JSON object');
    expectValidation(() => requireString([], 'f'), 'must be a JSON object');
  });
});

describe('optionalString', () => {
  it('retorna undefined para valores ausentes ou null', () => {
    expect(optionalString({}, 'ref')).toBeUndefined();
    expect(optionalString({ ref: null }, 'ref')).toBeUndefined();
  });

  it('valida valores presentes', () => {
    expect(optionalString({ ref: 'tx-1' }, 'ref')).toBe('tx-1');
    expectValidation(() => optionalString({ ref: 7 }, 'ref'), 'must be a string');
    expectValidation(() => optionalString({ ref: '' }, 'ref'), 'must not be empty');
  });
});

describe('requireUuid', () => {
  it('aceita UUIDs canônicos em qualquer caixa', () => {
    expect(requireUuid({ id: UUID }, 'id')).toBe(UUID);
    expect(requireUuid({ id: UUID.toUpperCase() }, 'id')).toBe(UUID.toUpperCase());
  });

  it('rejeita identificadores malformados', () => {
    expectValidation(() => requireUuid({ id: 'not-a-uuid' }, 'id'), 'must be a UUID');
    expectValidation(() => requireUuid({ id: `${UUID}0` }, 'id'), 'at most 36 characters');
    expectValidation(() => requireUuid({ id: UUID.replace(/-/g, '') }, 'id'), 'must be a UUID');
    expectValidation(() => requireUuid({ id: 123 }, 'id'), 'must be a string');
  });
});

describe('requireOneOf', () => {
  it('aceita valores permitidos e rejeita os demais (diferencia maiúsculas)', () => {
    expect(requireOneOf({ kind: 'BET' }, 'kind', ['BET', 'WIN'] as const)).toBe('BET');
    expectValidation(() => requireOneOf({ kind: 'bet' }, 'kind', ['BET'] as const), 'must be one of BET');
  });

  it('nunca deixa OPENING passar pela lista de kinds de submit', () => {
    expect(SUBMITTABLE_KINDS).not.toContain('OPENING' as never);
    expectValidation(
      () => parseSubmitWagerTransactionBody(submitBody({ kind: 'OPENING' })),
      'kind must be one of',
    );
  });
});

describe('parseMoneyProps', () => {
  it('aceita strings decimais e normaliza a escala para 2 casas', () => {
    expect(parseMoneyProps({ amount: '25.00', currency: 'BRL' }, 'money')).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parseMoneyProps({ amount: '25', currency: 'BRL' }, 'money')).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parseMoneyProps({ amount: '25.5', currency: 'BRL' }, 'money')).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(parseMoneyProps({ amount: '0.00', currency: 'BRL' }, 'money')).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('rejeita números JSON como amount (amount numérico vira 400)', () => {
    expectValidation(() => parseMoneyProps({ amount: 25, currency: 'BRL' }, 'money'), 'decimal string');
    expectValidation(() => parseMoneyProps({ amount: 25.5, currency: 'BRL' }, 'money'), 'decimal string');
  });

  it('rejeita strings decimais inválidas via Money.from', () => {
    for (const amount of ['1e5', '', '1.234', ' 1.00', '+1', '01.00', '-1', 'NaN', 'Infinity', '1,00']) {
      expectValidation(() => parseMoneyProps({ amount, currency: 'BRL' }, 'money'), 'money:');
    }
  });

  it('rejeita códigos de moeda inválidos', () => {
    expectValidation(() => parseMoneyProps({ amount: '1.00', currency: 'brl' }, 'money'), 'invalid currency');
    expectValidation(() => parseMoneyProps({ amount: '1.00', currency: 'BR' }, 'money'), 'invalid currency');
  });

  it('rejeita chaves desconhecidas ou ausentes, arrays e valores que não são objetos', () => {
    expectValidation(() => parseMoneyProps({ amount: '1.00', currency: 'BRL', extra: 1 }, 'money'), 'money.extra is not allowed');
    expectValidation(() => parseMoneyProps({ amount: '1.00' }, 'money'), 'money.currency must be a string');
    expectValidation(() => parseMoneyProps({ currency: 'BRL' }, 'money'), 'money.amount must be a decimal string');
    expectValidation(() => parseMoneyProps(undefined, 'money'), 'is required');
    expectValidation(() => parseMoneyProps('25.00 BRL', 'money'), 'must be an object');
    expectValidation(() => parseMoneyProps(['25.00', 'BRL'], 'money'), 'must be an object');
  });
});

describe('parseLimit', () => {
  it('usa 50 como padrão e aceita de 1 a 200', () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('200')).toBe(200);
  });

  it('rejeita zero, valor acima do limite, valor não numérico e valores repetidos', () => {
    for (const raw of ['0', '201', '-1', '1.5', 'abc', '', '99999']) {
      expectValidation(() => parseLimit(raw), 'limit must be an integer between 1 and 200');
    }
    expectValidation(() => parseLimit(['1', '2']), 'limit must be an integer');
  });
});

describe('parseOptionalCursor', () => {
  it('retorna undefined para cursor ausente ou vazio e repassa valores opacos', () => {
    expect(parseOptionalCursor(undefined)).toBeUndefined();
    expect(parseOptionalCursor('')).toBeUndefined();
    expect(parseOptionalCursor('MTI0')).toBe('MTI0');
  });

  it('rejeita cursors repetidos, grandes demais ou com caracteres de controle', () => {
    expectValidation(() => parseOptionalCursor(['a', 'b']), 'single value');
    expectValidation(() => parseOptionalCursor('x'.repeat(513)), 'at most 512');
    expectValidation(() => parseOptionalCursor('a\nb'), 'control characters');
  });
});

describe('parseIdempotencyKey', () => {
  it('aceita uma chave normal e uma de exatamente 512 caracteres', () => {
    expect(parseIdempotencyKey('provider-a:transaction-123')).toBe('provider-a:transaction-123');
    expect(parseIdempotencyKey('k'.repeat(512))).toHaveLength(512);
  });

  it('rejeita chave ausente, vazia, em branco ou grande demais', () => {
    expectValidation(() => parseIdempotencyKey(undefined), 'Idempotency-Key header is required');
    expectValidation(() => parseIdempotencyKey(''), 'must not be empty');
    expectValidation(() => parseIdempotencyKey('   '), 'must not be empty');
    expectValidation(() => parseIdempotencyKey('k'.repeat(513)), 'at most 512');
    expectValidation(() => parseIdempotencyKey(['a', 'b']), 'must be a string');
  });
});

describe('parseCreateWalletBody', () => {
  it('retorna playerId e o saldo inicial normalizado', () => {
    expect(parseCreateWalletBody({ playerId: UUID, initialBalance: { amount: '1000', currency: 'BRL' } })).toEqual({
      playerId: UUID,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
  });

  it('rejeita playerId inválido e saldo inicial numérico', () => {
    expectValidation(
      () => parseCreateWalletBody({ playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } }),
      'playerId must be a UUID',
    );
    expectValidation(
      () => parseCreateWalletBody({ playerId: UUID, initialBalance: { amount: 1000, currency: 'BRL' } }),
      'decimal string',
    );
    expectValidation(() => parseCreateWalletBody(null), 'must be a JSON object');
  });
});

describe('parseSubmitWagerTransactionBody', () => {
  it('aceita um BET e normaliza o money', () => {
    expect(parseSubmitWagerTransactionBody(submitBody({ money: { amount: '25', currency: 'BRL' } }))).toEqual({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: UUID,
      walletId: WALLET,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  it('inclui referenceExternalTransactionId somente quando presente', () => {
    const withRef = parseSubmitWagerTransactionBody(submitBody({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    expect(withRef.referenceExternalTransactionId).toBe('bet-1');
    const without = parseSubmitWagerTransactionBody(submitBody({}));
    expect('referenceExternalTransactionId' in without).toBe(false);
  });

  it('rejeita amount numérico em money', () => {
    expectValidation(
      () => parseSubmitWagerTransactionBody(submitBody({ money: { amount: 25, currency: 'BRL' } })),
      'money.amount must be a decimal string',
    );
  });

  it('rejeita campo ausente ou de tipo errado, com o nome do campo na mensagem', () => {
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ roundId: undefined })), 'roundId is required');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ gameId: 3 })), 'gameId must be a string');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ playerId: 'nope' })), 'playerId must be a UUID');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ walletId: 'nope' })), 'walletId must be a UUID');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ kind: 'DEPOSIT' })), 'kind must be one of');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ providerId: 'p'.repeat(65) })), 'providerId must have at most 64');
    expectValidation(() => parseSubmitWagerTransactionBody(submitBody({ externalTransactionId: 'e'.repeat(129) })), 'at most 128');
    expectValidation(() => parseSubmitWagerTransactionBody(null), 'request body must be a JSON object');
  });
});

function submitBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: UUID,
    walletId: WALLET,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}
