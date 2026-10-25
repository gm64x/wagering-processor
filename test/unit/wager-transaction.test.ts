import { describe, it, expect } from 'bun:test';
import {
  DomainError,
  FailureCode,
  InvalidTransactionStateError,
  LedgerDirection,
  Money,
  ValidationError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/index';

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-10-25T12:00:00.000Z');
const LATER = new Date('2026-10-25T12:01:00.000Z');

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
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
  };
}

function create(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(props(overrides));
}

function bet(id = 'bet-1'): WagerTransaction {
  return create({ id, externalTransactionId: `ext-${id}` });
}

function expectValidation(fn: () => unknown): void {
  expect(fn).toThrow(ValidationError);
}

describe('WagerTransaction.create', () => {
  it('começa PENDING com zero tentativas e sem resultado', () => {
    const tx = bet();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.createdAt).toEqual(NOW);
  });

  it('rejeita OPENING sem allowInternal', () => {
    expectValidation(() => create({ kind: Kind.Opening, providerId: 'internal' }));
  });

  it('aceita OPENING com allowInternal e providerId "internal"', () => {
    const tx = create({ kind: Kind.Opening, providerId: 'internal', allowInternal: true });
    expect(tx.kind).toBe(Kind.Opening);
  });

  it('rejeita OPENING com allowInternal, mas com provider que não é interno', () => {
    expectValidation(() => create({ kind: Kind.Opening, providerId: 'provider-a', allowInternal: true }));
  });

  it('rejeita REFUND e ROLLBACK sem referência', () => {
    expectValidation(() => create({ kind: Kind.Refund }));
    expectValidation(() => create({ kind: Kind.Rollback }));
    expectValidation(() => create({ kind: Kind.Refund, referenceExternalTransactionId: '' }));
  });

  it('aceita REFUND e ROLLBACK com referência', () => {
    const refund = create({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    expect(refund.referenceExternalTransactionId).toBe('ext-bet');
    expect(create({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-bet' }).kind).toBe(
      Kind.Rollback,
    );
  });

  it('rejeita referência em kinds que não a aceitam (BET, OPENING)', () => {
    expectValidation(() => create({ kind: Kind.Bet, referenceExternalTransactionId: 'ext-x' }));
  });

  it('rejeita valores não positivos para BET, WIN, REFUND e ROLLBACK', () => {
    expectValidation(() => create({ kind: Kind.Bet, money: money('0.00') }));
    expectValidation(() => create({ kind: Kind.Win, money: money('0.00') }));
    expectValidation(() =>
      create({ kind: Kind.Refund, referenceExternalTransactionId: 'r', money: money('0.00') }),
    );
    expectValidation(() =>
      create({ kind: Kind.Rollback, referenceExternalTransactionId: 'r', money: money('0.00') }),
    );
    expectValidation(() => create({ kind: Kind.Bet, money: money('1.00').negate() }));
  });

  it('aceita LOSS com amount 0.00, mas não negativo', () => {
    expect(create({ kind: Kind.Loss, money: money('0.00') }).kind).toBe(Kind.Loss);
    expectValidation(() => create({ kind: Kind.Loss, money: money('1.00').negate() }));
  });

  it('ValidationError tem código estável', () => {
    try {
      create({ kind: Kind.Bet, money: money('0.00') });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('transições de estado de WagerTransaction', () => {
  it('PENDING -> PENDING_REFERENCE incrementa attempts e define nextAttemptAt', () => {
    const tx = bet();
    tx.markPendingReference(LATER);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(LATER);
    expect(tx.isTerminal()).toBe(false);
  });

  it('PENDING_REFERENCE -> PENDING_REFERENCE continua incrementando attempts', () => {
    const tx = bet();
    tx.markPendingReference(LATER);
    tx.markPendingReference(LATER);
    tx.markPendingReference(LATER);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(3);
  });

  it('PENDING -> PROCESSED registra referência, saldo resultante e processedAt', () => {
    const tx = bet();
    tx.markProcessed(undefined, money('90.00'), LATER);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance?.amount).toBe('90.00');
    expect(tx.processedAt).toEqual(LATER);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING_REFERENCE -> PROCESSED armazena o referenceTransactionId', () => {
    const tx = create({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(LATER);
    tx.markProcessed('bet-uuid', money('120.00'), LATER);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('bet-uuid');
  });

  it('PENDING -> REJECTED registra failure code e saldo resultante', () => {
    const tx = bet();
    tx.reject(FailureCode.InsufficientFunds, money('5.00'), LATER);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultBalance?.amount).toBe('5.00');
    expect(tx.processedAt).toEqual(LATER);
  });

  it('PENDING_REFERENCE -> REJECTED é permitido', () => {
    const tx = bet();
    tx.markPendingReference(LATER);
    tx.reject(FailureCode.ReferenceNotFound, money('5.00'), LATER);
    expect(tx.status).toBe(Status.Rejected);
  });

  it('PENDING -> FAILED e PENDING_REFERENCE -> FAILED registram o failure code', () => {
    const a = bet('a');
    a.fail(FailureCode.ProcessingFailed, LATER);
    expect(a.status).toBe(Status.Failed);
    expect(a.failureCode).toBe(FailureCode.ProcessingFailed);

    const b = bet('b');
    b.markPendingReference(LATER);
    b.fail(FailureCode.ProcessingFailed, LATER);
    expect(b.status).toBe(Status.Failed);
  });

  describe.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, money('1.00'), LATER)],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.CurrencyMismatch, money('1.00'), LATER)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, LATER)],
  ])('status terminal %s', (_name, makeTerminal) => {
    const freshTerminal = (): WagerTransaction => {
      const tx = bet();
      makeTerminal(tx);
      return tx;
    };

    it('é terminal', () => {
      expect(freshTerminal().isTerminal()).toBe(true);
    });

    it('bloqueia markProcessed', () => {
      expect(() => freshTerminal().markProcessed(undefined, money('1.00'), LATER)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('bloqueia markPendingReference', () => {
      expect(() => freshTerminal().markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
    });

    it('bloqueia reject', () => {
      expect(() => freshTerminal().reject(FailureCode.InsufficientFunds, money('1.00'), LATER)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('bloqueia fail', () => {
      expect(() => freshTerminal().fail(FailureCode.ProcessingFailed, LATER)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('mantém o estado após uma transição bloqueada', () => {
      const tx = freshTerminal();
      const before = tx.toState();
      expect(() => tx.markPendingReference(LATER)).toThrow();
      expect(tx.toState()).toEqual(before);
    });

    it('erro tem código estável', () => {
      try {
        freshTerminal().fail(FailureCode.ProcessingFailed, LATER);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as DomainError).code).toBe('INVALID_TRANSACTION_STATE');
      }
    });
  });

  it('uma transação PENDING não é terminal', () => {
    expect(bet().isTerminal()).toBe(false);
  });
});

describe('predicados de kind de WagerTransaction', () => {
  it.each([
    [Kind.Bet, true],
    [Kind.Win, true],
    [Kind.Opening, true],
    [Kind.Refund, true],
    [Kind.Rollback, true],
    [Kind.Loss, false],
  ])('affectsBalance para %s é %s', (kind, expected) => {
    const tx = create({
      kind,
      providerId: kind === Kind.Opening ? 'internal' : 'provider-a',
      allowInternal: kind === Kind.Opening,
      referenceExternalTransactionId:
        kind === Kind.Refund || kind === Kind.Rollback || kind === Kind.Win || kind === Kind.Loss
          ? 'ref'
          : undefined,
      money: money(kind === Kind.Loss ? '0.00' : '1.00'),
    });
    expect(tx.affectsBalance()).toBe(expected);
  });

  it.each([
    [Kind.Refund, true],
    [Kind.Rollback, true],
    [Kind.Bet, false],
    [Kind.Win, false],
    [Kind.Loss, false],
  ])('requiresReference para %s é %s', (kind, expected) => {
    const tx = create({
      kind,
      referenceExternalTransactionId: expected || kind === Kind.Win || kind === Kind.Loss ? 'ref' : undefined,
      money: money(kind === Kind.Loss ? '0.00' : '1.00'),
    });
    expect(tx.requiresReference()).toBe(expected);
  });

  it.each([
    [Kind.Refund, true],
    [Kind.Rollback, true],
    [Kind.Win, true],
    [Kind.Loss, true],
    [Kind.Bet, false],
  ])('acceptsReference para %s é %s', (kind, expected) => {
    const tx = create({
      kind,
      referenceExternalTransactionId: expected ? 'ref' : undefined,
      money: money(kind === Kind.Loss ? '0.00' : '1.00'),
    });
    expect(tx.acceptsReference()).toBe(expected);
  });

  it('allowedReferenceKinds por kind', () => {
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: 'r' }).allowedReferenceKinds()).toEqual([
      Kind.Bet,
    ]);
    expect(create({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' }).allowedReferenceKinds()).toEqual([
      Kind.Bet,
      Kind.Win,
      Kind.Refund,
    ]);
    expect(create({ kind: Kind.Win, referenceExternalTransactionId: 'r' }).allowedReferenceKinds()).toEqual([
      Kind.Bet,
    ]);
    expect(create({ kind: Kind.Loss, money: money('0.00'), referenceExternalTransactionId: 'r' }).allowedReferenceKinds()).toEqual([
      Kind.Bet,
    ]);
    expect(bet().allowedReferenceKinds()).toEqual([]);
  });

  it('matchesPayload compara o hash armazenado', () => {
    const tx = bet();
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  const rollbackOf = (ref: WagerTransaction) =>
    create({ id: 'rb', kind: Kind.Rollback, referenceExternalTransactionId: ref.externalTransactionId });

  it('BET é DEBIT', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it('WIN, REFUND e OPENING são CREDIT', () => {
    expect(create({ kind: Kind.Win, referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      create({ kind: Kind.Opening, providerId: 'internal', allowInternal: true }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK de BET é CREDIT (reverte um débito)', () => {
    const ref = bet('ref-bet');
    expect(rollbackOf(ref).ledgerDirectionFor(ref)).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK de WIN é DEBIT (reverte um crédito)', () => {
    const ref = create({ id: 'ref-win', kind: Kind.Win, externalTransactionId: 'ext-win', referenceExternalTransactionId: 'ext-bet' });
    expect(rollbackOf(ref).ledgerDirectionFor(ref)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK de REFUND é DEBIT (reverte um crédito)', () => {
    const ref = create({ id: 'ref-refund', kind: Kind.Refund, externalTransactionId: 'ext-refund', referenceExternalTransactionId: 'ext-bet' });
    expect(rollbackOf(ref).ledgerDirectionFor(ref)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK sem referência lança ValidationError', () => {
    expectValidation(() => create({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' }).ledgerDirectionFor());
  });

  it('ROLLBACK de um kind que não pode ser revertido lança ValidationError', () => {
    const loss = create({ id: 'l', kind: Kind.Loss, externalTransactionId: 'ext-loss', money: money('0.00'), referenceExternalTransactionId: 'ext-bet' });
    expectValidation(() => rollbackOf(loss).ledgerDirectionFor(loss));
  });

  it('LOSS não tem direção de ledger e lança erro', () => {
    const loss = create({ kind: Kind.Loss, money: money('0.00'), referenceExternalTransactionId: 'r' });
    expectValidation(() => loss.ledgerDirectionFor());
  });
});

describe('ida e volta de estado de WagerTransaction', () => {
  it('toState e rehydrate preservam os dados sem validação', () => {
    const tx = bet();
    tx.markProcessed(undefined, money('90.00'), LATER);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.status).toBe(Status.Processed);
    expect(copy.resultBalance?.amount).toBe('90.00');
    expect(copy.processedAt).toEqual(LATER);
  });

  it('rehydrate não aplica as regras de criação', () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Opening, providerId: 'provider-a' }),
      status: Status.Pending,
      attempts: 0,
    });
    expect(tx.kind).toBe(Kind.Opening);
  });
});
