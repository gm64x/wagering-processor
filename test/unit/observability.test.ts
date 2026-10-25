import { describe, it, expect } from 'bun:test';
import type { Request, Response } from 'express';
import { PrometheusMetrics } from '../../src/infrastructure/observability/metrics';
import { createLogger } from '../../src/infrastructure/observability/logger';
import {
  CorrelationIdMiddleware,
  currentCorrelationId,
  runWithCorrelation,
} from '../../src/infrastructure/observability/correlation';

describe('PrometheusMetrics', () => {
  it('renderiza todas as métricas após os incrementos', async () => {
    const metrics = new PrometheusMetrics();
    metrics.transactionsTotal('PROCESSED', 'BET');
    metrics.duplicateDetected('http');
    metrics.retry('sqs');
    metrics.dlqMessage('MAX_RECEIVES');
    metrics.lockConflict();
    metrics.outboxLagSeconds(3);
    metrics.processingLatency(0.02, 'http');
    metrics.reconciliationDivergence();

    const { contentType, body } = await metrics.render();

    expect(contentType).toContain('text/plain');
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_retries_total',
      'wagering_dlq_messages_total',
      'wagering_lock_conflicts_total',
      'wagering_outbox_lag_seconds',
      'wagering_processing_latency_seconds',
      'wagering_reconciliation_divergences_total',
    ]) {
      expect(body).toContain(name);
    }
    expect(body).toContain('wagering_transactions_total{status="PROCESSED",kind="BET"} 1');
    expect(body).toContain('wagering_outbox_lag_seconds 3');
    expect(body).toContain('wagering_processing_latency_seconds_count{source="http"} 1');
  });

  it('mantém registries separados por instância', async () => {
    const a = new PrometheusMetrics();
    const b = new PrometheusMetrics();
    a.lockConflict();
    const { body } = await b.render();
    expect(body).toContain('wagering_lock_conflicts_total 0');
  });
});

describe('redação do createLogger', () => {
  function captureLogger() {
    const lines: string[] = [];
    const logger = createLogger({ write: (chunk: string) => void lines.push(chunk) });
    const last = () => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    return { logger, last, lines };
  }

  it('remove campos financeiros e de credenciais da saída', () => {
    const { logger, last, lines } = captureLogger();
    logger.info('tx processed', {
      transactionId: 'tx-1',
      money: { amount: '25.00', currency: 'BRL' },
      nested: { money: { amount: '99.99', currency: 'BRL' }, balance: '1234.00' },
      payload: { secret: 'abc' },
      authorization: 'Bearer token-value',
    });

    const entry = last();
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.money).toBeUndefined();
    expect(entry.payload).toBeUndefined();
    expect(entry.authorization).toBeUndefined();
    expect(lines.join('')).not.toContain('25.00');
    expect(lines.join('')).not.toContain('99.99');
    expect(lines.join('')).not.toContain('token-value');
  });

  it('emite JSON com campos base e o erro serializado em err', () => {
    const { logger, last } = captureLogger();
    logger.error('boom', { err: new Error('kaboom'), walletId: 'w-1' });

    const entry = last();
    expect(entry.service).toBe('wagering');
    expect(entry.level).toBe('error');
    expect(entry.walletId).toBe('w-1');
    expect((entry.err as { message: string }).message).toBe('kaboom');
  });

  it('anexa o correlation id do contexto às entradas', () => {
    const { logger, last } = captureLogger();
    runWithCorrelation('corr-42', () => logger.child({ providerId: 'p1' }).info('inside'));
    expect(last().correlationId).toBe('corr-42');
    expect(last().providerId).toBe('p1');
  });
});

describe('contexto de correlação', () => {
  it('retorna o id dentro da execução e undefined fora dela', () => {
    expect(currentCorrelationId()).toBeUndefined();
    const inside = runWithCorrelation('abc', () => currentCorrelationId());
    expect(inside).toBe('abc');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('mantém o id através de awaits', async () => {
    const seen = await runWithCorrelation('async-id', async () => {
      await Promise.resolve();
      return currentCorrelationId();
    });
    expect(seen).toBe('async-id');
  });
});

describe('CorrelationIdMiddleware', () => {
  function invoke(incoming?: string) {
    const headers: Record<string, string> = incoming === undefined ? {} : { 'x-correlation-id': incoming };
    const sent: Record<string, string> = {};
    let seen: string | undefined;
    const res = { setHeader: (k: string, v: string) => void (sent[k] = v) };
    new CorrelationIdMiddleware().use(
      { headers } as unknown as Request,
      res as unknown as Response,
      () => void (seen = currentCorrelationId()),
    );
    return { header: sent['x-correlation-id'], seen };
  }

  it('reaproveita um id válido recebido', () => {
    const { header, seen } = invoke('client-id-1');
    expect(header).toBe('client-id-1');
    expect(seen).toBe('client-id-1');
  });

  it('gera um uuid v7 quando o header está ausente ou é inseguro', () => {
    for (const bad of [undefined, 'has spaces\nand newline', 'x'.repeat(129)]) {
      const { header, seen } = invoke(bad);
      expect(header).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(seen).toBe(header);
    }
  });
});
