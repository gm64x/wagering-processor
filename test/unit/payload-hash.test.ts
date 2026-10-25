import { describe, it, expect } from 'bun:test';
import {
  canonicalJson,
  computePayloadHash,
  Money,
  WagerTransactionKind,
  type WagerBusinessFields,
} from '../../src/domain/index';

const base: WagerBusinessFields = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'p-1',
  walletId: 'w-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '10.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('ordena as chaves do objeto recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('omite valores undefined do objeto', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: { d: undefined, e: 2 } })).toBe('{"a":1,"c":{"e":2}}');
  });

  it('preserva a ordem do array e ordena as chaves dos itens', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3, 'x'])).toBe('[{"a":2,"b":1},3,"x"]');
  });

  it('serializa primitivos com as regras do JSON.stringify', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('usa toJSON em objetos que o definem (Money)', () => {
    expect(canonicalJson(Money.from({ amount: '5', currency: 'BRL' }))).toBe(
      '{"amount":"5.00","currency":"BRL"}',
    );
  });

  it('não tem espaços em branco', () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 'd' } })).not.toMatch(/\s/);
  });
});

describe('computePayloadHash', () => {
  it('retorna um digest sha256 hexadecimal minúsculo de 64 caracteres', () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é o mesmo independentemente da ordem das chaves na entrada', () => {
    const reordered: WagerBusinessFields = {
      money: { currency: 'BRL', amount: '10.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'w-1',
      playerId: 'p-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('normaliza o money, então "25" e "25.00" geram o mesmo hash', () => {
    const a = computePayloadHash({ ...base, money: { amount: '25', currency: 'BRL' } });
    const b = computePayloadHash({ ...base, money: { amount: '25.00', currency: 'BRL' } });
    expect(a).toBe(b);
  });

  it('ignora campos que não são de negócio', () => {
    const extra = { ...base, idempotencyKey: 'something-else' } as WagerBusinessFields;
    expect(computePayloadHash(extra)).toBe(computePayloadHash(base));
  });

  it('trata referência ausente e referência undefined como iguais', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(base),
    );
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'p-2' }],
    ['walletId', { walletId: 'w-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'game-2' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['money.amount', { money: { amount: '10.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '10.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'ext-ref' }],
  ])('muda quando %s muda', (_field, change) => {
    expect(computePayloadHash({ ...base, ...change } as WagerBusinessFields)).not.toBe(
      computePayloadHash(base),
    );
  });

  it('é estável entre chamadas', () => {
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
  });

  it('rejeita money inválido antes do hash', () => {
    expect(() => computePayloadHash({ ...base, money: { amount: '1e5', currency: 'BRL' } })).toThrow();
  });
});
