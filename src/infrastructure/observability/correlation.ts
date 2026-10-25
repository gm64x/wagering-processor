import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Ids recebidos são não confiáveis: restringe charset e tamanho para que não injetem conteúdo nos logs. */
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const storage = new AsyncLocalStorage<string>();

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const raw = req.headers[CORRELATION_HEADER];
    const correlationId = typeof raw === 'string' && VALID_ID.test(raw) ? raw : uuidv7();
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => next());
  }
}
