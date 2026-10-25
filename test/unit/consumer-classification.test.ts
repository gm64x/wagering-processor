import { describe, expect, it } from 'bun:test';
import { DuplicateMessageError, IdempotencyConflictError, NotFoundError, TransientInfrastructureError, WalletNotFoundError } from '../../src/application/dto';
import { InvalidMoneyError } from '../../src/domain/money';
import { ValidationError } from '../../src/domain/errors';
import {
  WAGER_CONSUMER_NAME,
  classifyError,
  failureReason,
  parseWagerEnvelope,
  toSubmitCommand,
} from '../../src/infrastructure/messaging/consumer-classification';

const SPEC_MESSAGE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

const body = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ ...SPEC_MESSAGE, ...overrides });

describe('classifyError', () => {
  it('faz ack de duplicatas e conflitos de idempotência', () => {
    expect(classifyError(new DuplicateMessageError('dup'))).toBe('ack');
    expect(classifyError(new IdempotencyConflictError('conflict'))).toBe('ack');
  });

  it('faz retry em falhas transitórias de infraestrutura e em erros desconhecidos', () => {
    expect(classifyError(new TransientInfrastructureError('db down'))).toBe('retry');
    expect(classifyError(new Error('socket hang up'))).toBe('retry');
    expect(classifyError('not an error object')).toBe('retry');
  });

  it('envia erros de domínio permanentes para a DLQ', () => {
    expect(classifyError(new ValidationError('bad payload'))).toBe('dlq');
    expect(classifyError(new WalletNotFoundError('no wallet'))).toBe('dlq');
    expect(classifyError(new InvalidMoneyError('bad amount'))).toBe('dlq');
    expect(classifyError(new NotFoundError('missing'))).toBe('dlq');
  });

  it('retorna um código de motivo estável para métricas e atributos da DLQ', () => {
    expect(failureReason(new ValidationError('x'))).toBe('VALIDATION_ERROR');
    expect(failureReason(new WalletNotFoundError('x'))).toBe('WALLET_NOT_FOUND');
    expect(failureReason(new TransientInfrastructureError('x'))).toBe('TRANSIENT_INFRASTRUCTURE');
    expect(failureReason(new Error('x'))).toBe('UNEXPECTED_ERROR');
  });
});

describe('parseWagerEnvelope', () => {
  it('interpreta o formato da mensagem da seção 10 da spec', () => {
    const parsed = parseWagerEnvelope(body());
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.type).toBe('WagerTransactionRequested');
    expect(parsed.data.kind).toBe('BET');
    expect(parsed.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parsed.data.referenceExternalTransactionId).toBeUndefined();
  });

  it('mantém a referência opcional e o correlation id quando presentes', () => {
    const parsed = parseWagerEnvelope(
      body({ data: { ...SPEC_MESSAGE.data, kind: 'REFUND', referenceExternalTransactionId: 'bet-1', correlationId: 'corr-9' } }),
    );
    expect(parsed.data.referenceExternalTransactionId).toBe('bet-1');
    expect(parsed.data.correlationId).toBe('corr-9');
  });

  it('rejeita body vazio, JSON inválido e body ausente como ValidationError', () => {
    expect(() => parseWagerEnvelope(undefined)).toThrow(ValidationError);
    expect(() => parseWagerEnvelope('')).toThrow(ValidationError);
    expect(() => parseWagerEnvelope('{not json')).toThrow(ValidationError);
    expect(() => parseWagerEnvelope('[]')).toThrow(ValidationError);
  });

  it('rejeita tipo de mensagem desconhecido', () => {
    expect(() => parseWagerEnvelope(body({ type: 'SomethingElse' }))).toThrow(ValidationError);
  });

  it('rejeita campo obrigatório ausente e cita apenas o caminho, não o valor', () => {
    const { walletId: _omit, ...withoutWallet } = SPEC_MESSAGE.data;
    let caught: unknown;
    try {
      parseWagerEnvelope(body({ data: withoutWallet }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).message).toContain('data.walletId');
  });

  it('rejeita money enviado como número JSON em vez de string decimal', () => {
    expect(() =>
      parseWagerEnvelope(body({ data: { ...SPEC_MESSAGE.data, money: { amount: 25, currency: 'BRL' } } })),
    ).toThrow(ValidationError);
  });
});

describe('toSubmitCommand', () => {
  it('mapeia o envelope para o command de caso de uso compartilhado, com a chave do inbox', () => {
    const command = toSubmitCommand(parseWagerEnvelope(body()));
    expect(command.idempotencyKey).toBe('provider-a:transaction-123');
    expect(command.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(command.inbox).toEqual({ consumerName: WAGER_CONSUMER_NAME, messageId: 'msg-123' });
    expect(command.correlationId).toBe('msg-123');
    expect('referenceExternalTransactionId' in command).toBe(false);
  });

  it('prefere data.correlationId quando informado', () => {
    const command = toSubmitCommand(parseWagerEnvelope(body({ data: { ...SPEC_MESSAGE.data, correlationId: 'corr-9' } })));
    expect(command.correlationId).toBe('corr-9');
  });
});
