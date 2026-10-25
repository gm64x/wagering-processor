export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

/** Forma serializada (outbox payload / mensagem SQS). `occurredAt` é ISO 8601. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: Readonly<T>;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(ctx: EventContext, aggregateId: string, data: T) {
    this.eventId = ctx.eventId;
    this.aggregateId = aggregateId;
    this.correlationId = ctx.correlationId;
    this.causationId = ctx.causationId;
    this.occurredAt = ctx.occurredAt;
    this.data = deepFreeze(data);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
