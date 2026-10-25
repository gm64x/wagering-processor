/** Portas da camada de aplicação (DI tokens + interfaces). Implementações vivem em infrastructure/. */

export const METRICS = Symbol('METRICS');
export interface Metrics {
  transactionsTotal(status: string, kind: string): void;
  duplicateDetected(source: 'http' | 'sqs' | 'outbox'): void;
  retry(component: 'sqs' | 'outbox' | 'pending_reference' | 'lock'): void;
  dlqMessage(reason: string): void;
  lockConflict(): void;
  outboxLagSeconds(seconds: number): void;
  processingLatency(seconds: number, source: 'http' | 'sqs' | 'worker'): void;
  reconciliationDivergence(): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
/** Logger estruturado. `ctx` aceita apenas ids (correlationId, messageId, transactionId, walletId, providerId…), nunca payloads. */
export interface AppLogger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext & { err?: unknown }): void;
  child(bindings: LogContext): AppLogger;
}
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/**
 * Ponto de extensão de autenticação (seção 2 do desafio). Implementação atual: no-op.
 * Um IdP OIDC (Keycloak/Zitadel) resolveria o provider a partir do token client_credentials.
 */
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
export interface ProviderIdentityPort {
  /** Retorna o providerId autenticado, ou undefined quando auth está desligada. */
  resolve(authorizationHeader: string | undefined): Promise<string | undefined>;
}

/** Publicação de eventos de integração (usada só pelo outbox publisher, nunca pelo use case). */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export interface EventPublisher {
  publish(message: { id: string; aggregateId: string; eventType: string; payload: unknown }): Promise<void>;
}

export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): Date;
}
