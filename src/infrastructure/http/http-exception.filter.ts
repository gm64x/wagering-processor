import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/dto';
import { APP_LOGGER, type AppLogger } from '../../application/ports';
import { CORRELATION_HEADER } from '../observability/correlation';
import { CurrencyMismatchError, InvalidMoneyError } from '../../domain/money';
import { ValidationError } from '../../domain/errors';
import { v7 as uuidv7 } from 'uuid';

export interface ErrorBody {
  error: { code: string; message: string };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
  /** Só erros inesperados/infra são logados; erros de cliente não. */
  logLevel?: 'warn' | 'error';
}

const INTERNAL_MESSAGE = 'Internal server error';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_MESSAGE_LENGTH = 300;

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message: message.slice(0, MAX_MESSAGE_LENGTH) } };
}

function internal(): MappedError {
  return { status: 500, body: errorBody('INTERNAL_ERROR', INTERNAL_MESSAGE), logLevel: 'error' };
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return 'HTTP_ERROR';
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function messageOf(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = (response as { message: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((m) => typeof m === 'string')) return message.join('; ');
  }
  return undefined;
}

function mapHttpException(exception: HttpException): MappedError {
  const status = exception.getStatus();
  const response = exception.getResponse();
  if (status >= 500) return internal();
  // Corpo já no formato da API (ex.: PROVIDER_MISMATCH do guard): preserva código e mensagem.
  if (isErrorBody(response)) {
    return { status, body: errorBody(response.error.code, response.error.message) };
  }
  return {
    status,
    body: errorBody(codeForStatus(status), messageOf(response) ?? exception.message),
  };
}

/** Erros do body-parser (JSON malformado, corpo grande) carregam type/status/expose. */
function bodyParserStatus(exception: unknown): number | undefined {
  if (!(exception instanceof Error)) return undefined;
  const e = exception as Error & { type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof e.type !== 'string' || e.expose !== true || typeof status !== 'number') return undefined;
  return status >= 400 && status < 500 ? status : undefined;
}

function bodyParserMapped(status: number, type: unknown): MappedError {
  if (status === 413) return { status, body: errorBody('PAYLOAD_TOO_LARGE', 'Request body too large') };
  const message = type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body';
  return { status, body: errorBody(codeForStatus(status), message) };
}

/**
 * Converte qualquer exceção em status + corpo { error: { code, message } }.
 * Função pura: não loga, não expõe stack. Mapeamento conforme a tabela "Mapeamento HTTP" do ARCHITECTURE.md.
 */
export function mapException(exception: unknown): MappedError {
  if (
    exception instanceof ValidationError ||
    exception instanceof InvalidMoneyError ||
    exception instanceof CurrencyMismatchError
  ) {
    return { status: 400, body: errorBody('VALIDATION_ERROR', exception.message) };
  }
  if (exception instanceof WalletNotFoundError) {
    return { status: 404, body: errorBody('WALLET_NOT_FOUND', 'Wallet not found') };
  }
  if (exception instanceof NotFoundError) {
    return { status: 404, body: errorBody('NOT_FOUND', 'Resource not found') };
  }
  if (exception instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key was already used with a different payload'),
    };
  }
  if (exception instanceof WalletAlreadyExistsError) {
    return { status: 409, body: errorBody('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency') };
  }
  if (exception instanceof TransientInfrastructureError) {
    return {
      status: 503,
      body: errorBody('TRANSIENT_INFRASTRUCTURE', 'Temporarily unavailable, retry later'),
      retryAfterSeconds: 1,
      logLevel: 'warn',
    };
  }
  if (exception instanceof HttpException) return mapHttpException(exception);

  const bodyStatus = bodyParserStatus(exception);
  if (bodyStatus !== undefined) {
    return bodyParserMapped(bodyStatus, (exception as { type?: unknown }).type);
  }
  return internal();
}

function routeOf(req: Request): string {
  const path = (req as { route?: { path?: unknown } }).route?.path;
  return typeof path === 'string' ? path : 'unmatched';
}

/** Filtro global (APP_FILTER). Sempre responde JSON no formato { error: { code, message } }. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const mapped = mapException(exception);
    const route = routeOf(req);

    if (mapped.logLevel === 'error') {
      this.logger.error('request failed', { err: exception, method: req.method, route, status: mapped.status, code: mapped.body.error.code });
    } else if (mapped.logLevel === 'warn') {
      this.logger.warn('request temporarily unavailable', { method: req.method, route, status: mapped.status, code: mapped.body.error.code });
    }

    if (res.headersSent) return;
    // Erros do body-parser (JSON malformado) chegam aqui sem passar pelo CorrelationIdMiddleware:
    // o header é garantido aqui para que toda resposta ecoe x-correlation-id.
    if (res.getHeader(CORRELATION_HEADER) === undefined) {
      const incoming = req.headers?.[CORRELATION_HEADER];
      res.setHeader(
        CORRELATION_HEADER,
        typeof incoming === 'string' && VALID_CORRELATION_ID.test(incoming) ? incoming : uuidv7(),
      );
    }
    if (mapped.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    res.status(mapped.status).json(mapped.body);
  }
}
