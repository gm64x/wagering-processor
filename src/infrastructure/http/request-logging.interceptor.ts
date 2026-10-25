import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { APP_LOGGER, METRICS, type AppLogger, type LogContext, type Metrics } from '../../application/ports';

const SUBMIT_ROUTE = '/wagering/transactions';
const ID_PARAMS = ['walletId', 'transactionId', 'providerId'] as const;

function routeOf(req: Request): string {
  const path = (req as { route?: { path?: unknown } }).route?.path;
  return typeof path === 'string' ? path : 'unmatched';
}

/** Só ids das rotas entram no log. Corpo, query e headers nunca são logados. */
function idsOf(req: Request): LogContext {
  const params = req.params as Record<string, unknown> | undefined;
  const ids: LogContext = {};
  for (const name of ID_PARAMS) {
    const value = params?.[name];
    if (typeof value === 'string' && value.length <= 128) ids[name] = value;
  }
  return ids;
}

/**
 * Registra método, rota, status, duração e correlationId de cada requisição HTTP.
 * Duração e status são lidos no evento 'finish' da resposta, quando o status final já foi definido
 * (inclusive pelo exception filter). A latência de processamento é medida no WageringService (evita dupla contagem).
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    res.once('finish', () => this.record(req, res, startedAt));
    return next.handle();
  }

  private record(req: Request, res: Response, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeOf(req);
    const entry: LogContext = {
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ...idsOf(req),
    };

    if (route.startsWith('/health')) {
      this.logger.debug('request', entry);
    } else if (res.statusCode >= 500) {
      this.logger.warn('request', entry);
    } else {
      this.logger.info('request', entry);
    }
  }
}
