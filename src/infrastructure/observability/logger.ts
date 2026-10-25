import { hostname } from 'node:os';
import { inspect } from 'node:util';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppLogger, LogContext } from '../../application/ports';
import { currentCorrelationId } from './correlation';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/** Payloads financeiros e credenciais nunca podem chegar à saída do log. */
const REDACT_PATHS = [
  'money', '*.money',
  'payload', '*.payload',
  'balance', '*.balance',
  'authorization', '*.authorization',
  'body', '*.body',
];

function resolveLevel(): string {
  const requested = process.env.LOG_LEVEL?.toLowerCase();
  return requested && LEVELS.includes(requested) ? requested : 'info';
}

function buildPino(destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level: resolveLevel(),
    base: { service: 'wagering', instance: process.env.INSTANCE_ID ?? hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
    redact: { paths: REDACT_PATHS, remove: true },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Adiciona o correlationId do contexto a cada entrada, salvo quando o chamador já informou um. */
function withCorrelation(ctx: LogContext = {}): LogContext {
  const correlationId = ctx.correlationId ?? currentCorrelationId();
  return correlationId === undefined ? ctx : { ...ctx, correlationId };
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  debug(msg: string, ctx?: LogContext): void {
    this.logger.debug(withCorrelation(ctx), msg);
  }

  info(msg: string, ctx?: LogContext): void {
    this.logger.info(withCorrelation(ctx), msg);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.logger.warn(withCorrelation(ctx), msg);
  }

  error(msg: string, ctx?: LogContext & { err?: unknown }): void {
    this.logger.error(withCorrelation(ctx), msg);
  }

  child(bindings: LogContext): AppLogger {
    return new PinoAppLogger(this.logger.child(bindings));
  }
}

export function createLogger(destination?: DestinationStream): AppLogger {
  return new PinoAppLogger(buildPino(destination));
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const stringify = (message: unknown): string => (typeof message === 'string' ? message : inspect(message));

/** Encaminha os logs do próprio Nest pelo mesmo pipeline JSON do pino usado nos logs da aplicação. */
export class NestPinoLoggerAdapter implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(stringify(message), { context: asString(params.at(-1)) });
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(stringify(message), { context: asString(params.at(-1)) });
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.debug(stringify(message), { context: asString(params.at(-1)) });
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(stringify(message), { context: asString(params.at(-1)) });
  }

  // O Nest chama error(message, stack?, context?)
  error(message: unknown, ...params: unknown[]): void {
    const [stack, context] = params;
    this.logger.error(stringify(message), { stack: asString(stack), context: asString(context) });
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.error(message, ...params);
  }
}
