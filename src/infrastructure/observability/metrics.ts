import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/ports';

type Source = 'http' | 'sqs' | 'outbox';
type RetryComponent = 'sqs' | 'outbox' | 'pending_reference' | 'lock';
type LatencySource = 'http' | 'sqs' | 'worker';

@Injectable()
export class PrometheusMetrics implements Metrics {
  private readonly reg = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions by final status and kind',
    labelNames: ['status', 'kind'],
    registers: [this.reg],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate deliveries detected, by entry point',
    labelNames: ['source'],
    registers: [this.reg],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by component',
    labelNames: ['component'],
    registers: [this.reg],
  });

  private readonly dlq = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue, by reason',
    labelNames: ['reason'],
    registers: [this.reg],
  });

  private readonly locks = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Wallet row lock conflicts',
    registers: [this.reg],
  });

  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.reg],
  });

  private readonly latency = new Histogram({
    name: 'wagering_processing_latency_seconds',
    help: 'Use case processing latency by source',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.reg],
  });

  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Wallet balance divergences found by reconciliation',
    registers: [this.reg],
  });

  constructor() {
    collectDefaultMetrics({ register: this.reg });
  }

  get registry(): Registry {
    return this.reg;
  }

  transactionsTotal(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }

  duplicateDetected(source: Source): void {
    this.duplicates.inc({ source });
  }

  retry(component: RetryComponent): void {
    this.retries.inc({ component });
  }

  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }

  lockConflict(): void {
    this.locks.inc();
  }

  outboxLagSeconds(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  processingLatency(seconds: number, source: LatencySource): void {
    this.latency.observe({ source }, seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.reg.contentType, body: await this.reg.metrics() };
  }
}
