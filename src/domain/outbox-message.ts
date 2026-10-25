import type { IntegrationEvent, IntegrationEventEnvelope } from './events/integration-event';

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300_000;
const MAX_ERROR_CHARS = 500;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

/** Evento pendente de publicação. Gravado na mesma transação da mudança de estado. */
export class OutboxMessage {
  private state: OutboxMessageState;

  private constructor(state: OutboxMessageState) {
    this.state = state;
  }

  /**
   * id = eventId, payload = envelope do evento, nextAttemptAt = occurredAt.
   * O parâmetro `now` é aceito por compatibilidade com o contrato e não altera o agendamento.
   */
  static enqueue(event: IntegrationEvent<unknown>, _now?: Date): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  /** Não valida: reconstrói o estado persistido tal como está. */
  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...s });
  }

  get id(): string {
    return this.state.id;
  }

  get aggregateId(): string {
    return this.state.aggregateId;
  }

  get eventType(): string {
    return this.state.eventType;
  }

  get payload(): IntegrationEventEnvelope<unknown> {
    return this.state.payload;
  }

  get occurredAt(): Date {
    return this.state.occurredAt;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date {
    return this.state.nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this.state.publishedAt;
  }

  get lastError(): string | undefined {
    return this.state.lastError;
  }

  /** attempts++ e nextAttemptAt = now + min(1s * 2^(attempts-1), 5min). */
  scheduleRetry(now: Date, error?: string): void {
    this.state.attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this.state.attempts - 1), MAX_DELAY_MS);
    this.state.nextAttemptAt = new Date(now.getTime() + delay);
    if (error !== undefined) {
      this.state.lastError = Array.from(error).slice(0, MAX_ERROR_CHARS).join('');
    }
  }

  markPublished(at: Date): void {
    this.state.publishedAt = at;
  }

  toState(): OutboxMessageState {
    return { ...this.state };
  }
}
