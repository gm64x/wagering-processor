import { describe, it, expect } from 'bun:test';
import {
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionProcessed,
} from '../../src/domain/index';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

function makeEvent() {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('10.00'),
    createdAt: NOW,
  });
  return WagerTransactionProcessed.from(tx, money('90.00'), {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    occurredAt: NOW,
  });
}

function fresh(): OutboxMessage {
  return OutboxMessage.enqueue(makeEvent());
}

describe('OutboxMessage.enqueue', () => {
  it('usa o eventId como id e o envelope como payload', () => {
    const event = makeEvent();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.payload).toEqual(event.toJSON());
    expect(msg.aggregateId).toBe('w-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
  });

  it('começa com zero tentativas, nextAttemptAt = occurredAt e sem erro', () => {
    const msg = fresh();
    expect(msg.attempts).toBe(0);
    expect(msg.nextAttemptAt).toEqual(NOW);
    expect(msg.occurredAt).toEqual(NOW);
    expect(msg.lastError).toBeUndefined();
    expect(msg.publishedAt).toBeUndefined();
  });
});

describe('backoff de OutboxMessage.scheduleRetry', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('usa min(1s * 2^(attempts-1), 5min)', () => {
    const msg = fresh();
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000];
    for (const delay of expected) {
      msg.scheduleRetry(NOW);
      expect(msg.nextAttemptAt.getTime() - NOW.getTime()).toBe(delay);
    }
    expect(msg.attempts).toBe(expected.length);
  });

  it('limita o atraso em 5 minutos', () => {
    const msg = fresh();
    for (let i = 0; i < 10; i++) msg.scheduleRetry(NOW);
    expect(msg.nextAttemptAt).toEqual(at(300_000));
    msg.scheduleRetry(NOW);
    expect(msg.nextAttemptAt).toEqual(at(300_000));
  });

  it('continua limitado para contagens muito grandes de tentativas, sem estouro', () => {
    const msg = OutboxMessage.rehydrate({ ...fresh().toState(), attempts: 5000 });
    msg.scheduleRetry(NOW);
    expect(msg.attempts).toBe(5001);
    expect(msg.nextAttemptAt).toEqual(at(300_000));
  });

  it('calcula a partir do now informado, não do agendamento anterior', () => {
    const msg = fresh();
    const later = at(60_000);
    msg.scheduleRetry(later);
    expect(msg.nextAttemptAt).toEqual(new Date(later.getTime() + 1_000));
  });
});

describe('lastError de OutboxMessage.scheduleRetry', () => {
  it('guarda a mensagem de erro', () => {
    const msg = fresh();
    msg.scheduleRetry(NOW, 'broker unavailable');
    expect(msg.lastError).toBe('broker unavailable');
  });

  it('trunca o erro armazenado em 500 caracteres', () => {
    const msg = fresh();
    msg.scheduleRetry(NOW, 'x'.repeat(1200));
    expect(msg.lastError?.length).toBe(500);
  });

  it('mantém o erro anterior quando nenhum é informado', () => {
    const msg = fresh();
    msg.scheduleRetry(NOW, 'first');
    msg.scheduleRetry(NOW);
    expect(msg.lastError).toBe('first');
  });
});

describe('publicação e estado de OutboxMessage', () => {
  it('markPublished define publishedAt', () => {
    const msg = fresh();
    msg.markPublished(NOW);
    expect(msg.publishedAt).toEqual(NOW);
  });

  it('toState e rehydrate fazem ida e volta', () => {
    const msg = fresh();
    msg.scheduleRetry(NOW, 'boom');
    const copy = OutboxMessage.rehydrate(msg.toState());
    expect(copy.attempts).toBe(1);
    expect(copy.lastError).toBe('boom');
    expect(copy.id).toBe(msg.id);
  });
});
