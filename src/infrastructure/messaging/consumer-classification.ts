import { DuplicateMessageError, IdempotencyConflictError, TransientInfrastructureError } from '../../application/dto';
import type { SubmitWagerTransactionCommand } from '../../application/dto';
import { DomainError, ValidationError } from '../../domain/errors';

/** Lógico (não é nome de fila): chave de inbox e de atribuição de origem. */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
export const WAGER_REQUESTED_TYPE = 'WagerTransactionRequested';

/**
 * ack   -> já processado (duplicata) ou conflito de idempotência: remove a mensagem.
 * retry -> falha transitória ou desconhecida: visibilidade com backoff; DLQ ao atingir maxReceives.
 * dlq   -> erro permanente de payload/negócio (ValidationError, WalletNotFoundError, moeda/valor inválidos).
 */
export type Disposition = 'ack' | 'retry' | 'dlq';

export function classifyError(err: unknown): Disposition {
  if (err instanceof DuplicateMessageError || err instanceof IdempotencyConflictError) return 'ack';
  if (err instanceof TransientInfrastructureError) return 'retry';
  if (err instanceof DomainError) return 'dlq';
  return 'retry';
}

/** Código estável e de baixa cardinalidade, usado como motivo de DLQ e label de métrica. */
export function failureReason(err: unknown): string {
  if (err instanceof DomainError) return err.code;
  if (err instanceof TransientInfrastructureError) return err.code;
  return 'UNEXPECTED_ERROR';
}

export interface WagerRequestedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface ParsedWagerMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerRequestedData;
}

type JsonObject = Record<string, unknown>;

// As mensagens de erro citam apenas o caminho do campo, nunca o valor (evita vazar dinheiro/ids em log).
function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(obj: JsonObject, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: JsonObject, key: string, path: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}.${key} must be a non-empty string when present`);
  }
  return value;
}

/** Valida o envelope `{messageId,type,occurredAt,data}` da seção 10. Qualquer falha é ValidationError (DLQ). */
export function parseWagerEnvelope(body: string | undefined): ParsedWagerMessage {
  if (body === undefined || body.length === 0) {
    throw new ValidationError('message body is empty');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ValidationError('message body is not valid JSON');
  }
  const envelope = asObject(raw, 'envelope');
  const messageId = requiredString(envelope, 'messageId', 'envelope');
  const type = requiredString(envelope, 'type', 'envelope');
  if (type !== WAGER_REQUESTED_TYPE) {
    throw new ValidationError(`unsupported message type "${type}"`);
  }
  const occurredAt = requiredString(envelope, 'occurredAt', 'envelope');
  const data = asObject(envelope.data, 'data');
  const money = asObject(data.money, 'data.money');

  const parsed: ParsedWagerMessage = {
    messageId,
    type,
    occurredAt,
    data: {
      providerId: requiredString(data, 'providerId', 'data'),
      externalTransactionId: requiredString(data, 'externalTransactionId', 'data'),
      idempotencyKey: requiredString(data, 'idempotencyKey', 'data'),
      playerId: requiredString(data, 'playerId', 'data'),
      walletId: requiredString(data, 'walletId', 'data'),
      roundId: requiredString(data, 'roundId', 'data'),
      gameId: requiredString(data, 'gameId', 'data'),
      kind: requiredString(data, 'kind', 'data'),
      money: {
        amount: requiredString(money, 'amount', 'data.money'),
        currency: requiredString(money, 'currency', 'data.money'),
      },
    },
  };
  const referenceExternalTransactionId = optionalString(data, 'referenceExternalTransactionId', 'data');
  if (referenceExternalTransactionId !== undefined) {
    parsed.data.referenceExternalTransactionId = referenceExternalTransactionId;
  }
  const correlationId = optionalString(data, 'correlationId', 'data');
  if (correlationId !== undefined) parsed.data.correlationId = correlationId;
  return parsed;
}

/** Mapeia a mensagem para o mesmo comando usado pelo HTTP, com a chave de inbox da entrada SQS. */
export function toSubmitCommand(message: ParsedWagerMessage): SubmitWagerTransactionCommand {
  const d = message.data;
  const command: SubmitWagerTransactionCommand = {
    idempotencyKey: d.idempotencyKey,
    providerId: d.providerId,
    externalTransactionId: d.externalTransactionId,
    playerId: d.playerId,
    walletId: d.walletId,
    roundId: d.roundId,
    gameId: d.gameId,
    kind: d.kind,
    money: { amount: d.money.amount, currency: d.money.currency },
    correlationId: d.correlationId ?? message.messageId,
    inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: message.messageId },
  };
  if (d.referenceExternalTransactionId !== undefined) {
    command.referenceExternalTransactionId = d.referenceExternalTransactionId;
  }
  return command;
}
