import { describe, expect, it } from 'bun:test';
import { HttpException, HttpStatus, NotFoundException, BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import {
  DuplicateMessageError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  type WagerTransactionResult,
} from '../../src/application/dto';
import type { AppLogger, LogContext } from '../../src/application/ports';
import { InvalidLedgerEntryError, ValidationError } from '../../src/domain/errors';
import { InvalidMoneyError, CurrencyMismatchError } from '../../src/domain/money';
import { FailureCode } from '../../src/domain/failure-codes';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import {
  HttpExceptionFilter,
  mapException,
} from '../../src/infrastructure/http/http-exception.filter';
import { submitStatusCode } from '../../src/infrastructure/http/http-status';

interface LoggedCall {
  level: 'warn' | 'error' | 'info' | 'debug';
  msg: string;
  ctx?: LogContext;
}

function fakeLogger(): { logger: AppLogger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const record = (level: LoggedCall['level']) => (msg: string, ctx?: LogContext) => {
    calls.push({ level, msg, ctx });
  };
  const logger: AppLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, calls };
}

interface FakeResponse {
  statusCode: number | undefined;
  body: unknown;
  headers: Record<string, string>;
  headersSent: boolean;
  status(code: number): FakeResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  json(body: unknown): FakeResponse;
}

function fakeResponse(headersSent = false): FakeResponse {
  const res: FakeResponse = {
    statusCode: undefined,
    body: undefined,
    headers: {},
    headersSent,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    getHeader(name) {
      return res.headers[name];
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function hostFor(res: FakeResponse, method = 'POST', route: string | undefined = '/wagering/transactions'): ArgumentsHost {
  const req = { method, route: route === undefined ? undefined : { path: route } };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

function run(exception: unknown, route?: string): { res: FakeResponse; calls: LoggedCall[] } {
  const { logger, calls } = fakeLogger();
  const res = fakeResponse();
  new HttpExceptionFilter(logger).catch(exception, hostFor(res, 'POST', route));
  return { res, calls };
}

describe('HttpExceptionFilter: erros de domínio e de aplicação', () => {
  it('mapeia erros de validação de entrada para 400 VALIDATION_ERROR', () => {
    const { res } = run(new ValidationError('playerId must be a UUID'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'playerId must be a UUID' } });
  });

  it('mapeia erros de money e de moeda na entrada para 400 VALIDATION_ERROR', () => {
    expect(run(new InvalidMoneyError('invalid amount: "1e5"')).res.statusCode).toBe(400);
    expect(run(new CurrencyMismatchError('BRL', 'USD')).res.statusCode).toBe(400);
    expect(run(new InvalidMoneyError('x')).res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'x' } });
  });

  it('mapeia wallet ausente para 404 WALLET_NOT_FOUND e recurso ausente para 404 NOT_FOUND', () => {
    const wallet = run(new WalletNotFoundError('wallet not found')).res;
    expect(wallet.statusCode).toBe(404);
    expect((wallet.body as { error: { code: string } }).error.code).toBe('WALLET_NOT_FOUND');

    const generic = run(new NotFoundError('transaction not found')).res;
    expect(generic.statusCode).toBe(404);
    expect((generic.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('mapeia conflitos de idempotência e wallets duplicadas para 409', () => {
    const conflict = run(new IdempotencyConflictError('same key, different payload')).res;
    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const duplicate = run(new WalletAlreadyExistsError('dup')).res;
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.body as { error: { code: string } }).error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('mapeia falhas transitórias de infraestrutura para 503 com Retry-After: 1 e registra um warning', () => {
    const { res, calls } = run(new TransientInfrastructureError('connection refused'));
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(res.body).toEqual({ error: { code: 'TRANSIENT_INFRASTRUCTURE', message: 'Temporarily unavailable, retry later' } });
    expect(calls.map((c) => c.level)).toEqual(['warn']);
  });

  it('não mapeia DuplicateMessageError (somente SQS) para sucesso nem erro de cliente: cai em 500', () => {
    const { res } = run(new DuplicateMessageError('dup'));
    expect(res.statusCode).toBe(500);
  });
});

describe('HttpExceptionFilter: erros inesperados', () => {
  it('mapeia erros desconhecidos para 500 INTERNAL_ERROR, registra o objeto de erro e nunca vaza a mensagem nem a stack', () => {
    const secret = new Error('password=hunter2 at /app/src/secret.ts:10');
    const { res, calls } = run(secret);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('secret.ts');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe('error');
    expect(calls[0]?.ctx?.err).toBe(secret);
  });

  it('mapeia violações de invariante de domínio sem mapeamento HTTP para 500', () => {
    const { res, calls } = run(new InvalidLedgerEntryError('balanceAfter negative'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(calls[0]?.level).toBe('error');
    expect(run({ code: 'SOMETHING' }).res.statusCode).toBe(500);
  });

  it('mapeia valores lançados que não são Error para 500', () => {
    expect(run('boom').res.statusCode).toBe(500);
    expect(run(undefined).res.statusCode).toBe(500);
  });
});

describe('HttpExceptionFilter: HttpException do Nest', () => {
  it('mapeia rota não encontrada para 404 NOT_FOUND e mantém a mensagem do Nest', () => {
    const { res } = run(new NotFoundException('Cannot GET /nope'));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Cannot GET /nope' } });
  });

  it('mapeia HttpException de bad request para 400 VALIDATION_ERROR', () => {
    const { res } = run(new BadRequestException('bad'));
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('mantém o código de um HttpException cujo body já está no formato da API (PROVIDER_MISMATCH)', () => {
    const { res } = run(
      new HttpException({ error: { code: 'PROVIDER_MISMATCH', message: 'providerId does not match', extra: 'x' } }, HttpStatus.FORBIDDEN),
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: 'PROVIDER_MISMATCH', message: 'providerId does not match' } });
  });

  it('converte mensagens do Nest em array para uma única string', () => {
    const { res } = run(new HttpException({ message: ['a must be x', 'b must be y'] }, HttpStatus.UNPROCESSABLE_ENTITY));
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: { message: string } }).error.message).toBe('a must be x; b must be y');
  });

  it('não vaza a mensagem de um HttpException 5xx', () => {
    const { res, calls } = run(new HttpException('db host db-prod-1 refused', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(calls[0]?.level).toBe('error');
  });
});

describe('HttpExceptionFilter: erros do body-parser e tratamento da resposta', () => {
  function parseError(type: string, status: number): Error & { type: string; status: number; expose: boolean } {
    const err = new Error('Unexpected token } in JSON at position 5') as Error & { type: string; status: number; expose: boolean };
    err.type = type;
    err.status = status;
    err.expose = true;
    return err;
  }

  it('mapeia JSON malformado para 400 VALIDATION_ERROR sem repetir a mensagem do parser', () => {
    const mapped = mapException(parseError('entity.parse.failed', 400));
    expect(mapped.status).toBe(400);
    expect(mapped.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
  });

  it('mapeia body grande demais para 413', () => {
    const mapped = mapException(parseError('entity.too.large', 413));
    expect(mapped.status).toBe(413);
    expect(mapped.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('ignora erros que parecem de body-parser, mas não são expostos', () => {
    const err = parseError('entity.parse.failed', 400);
    err.expose = false;
    expect(mapException(err).status).toBe(500);
  });

  it('não escreve nada quando os headers já foram enviados', () => {
    const { logger } = fakeLogger();
    const res = fakeResponse(true);
    new HttpExceptionFilter(logger).catch(new WalletNotFoundError('x'), hostFor(res));
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });

  it('não registra erros de cliente (4xx)', () => {
    expect(run(new ValidationError('bad')).calls).toHaveLength(0);
    expect(run(new WalletNotFoundError('x')).calls).toHaveLength(0);
  });

  it('define x-correlation-id quando a requisição não passou pelo middleware de correlação', () => {
    const { logger } = fakeLogger();
    const res = fakeResponse();
    new HttpExceptionFilter(logger).catch(parseError('entity.parse.failed', 400), {
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: { 'x-correlation-id': 'req-42' } }), getResponse: () => res }),
    } as never);
    expect(res.headers['x-correlation-id']).toBe('req-42');
  });

  it('gera um correlation id quando o recebido está ausente ou é inválido, e mantém o existente', () => {
    const { logger } = fakeLogger();
    const noHeader = fakeResponse();
    new HttpExceptionFilter(logger).catch(new WalletNotFoundError('x'), hostFor(noHeader));
    expect(typeof noHeader.headers['x-correlation-id']).toBe('string');

    const invalid = fakeResponse();
    new HttpExceptionFilter(logger).catch(new WalletNotFoundError('x'), {
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', headers: { 'x-correlation-id': 'bad id!' } }), getResponse: () => invalid }),
    } as never);
    expect(invalid.headers['x-correlation-id']).not.toBe('bad id!');
    expect(invalid.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);

    const existing = fakeResponse();
    existing.headers['x-correlation-id'] = 'from-middleware';
    new HttpExceptionFilter(logger).catch(new WalletNotFoundError('x'), hostFor(existing));
    expect(existing.headers['x-correlation-id']).toBe('from-middleware');
  });
});

describe('submitStatusCode', () => {
  function result(status: WagerTransactionStatus, idempotentReplay = false, failureCode?: FailureCode): WagerTransactionResult {
    return {
      transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
      status,
      balance: { amount: '0.00', currency: 'BRL' },
      idempotentReplay,
      ...(failureCode !== undefined ? { failureCode } : {}),
    };
  }

  it('mapeia o resultado do processamento para os status codes do contrato', () => {
    expect(submitStatusCode(result(WagerTransactionStatus.Processed))).toBe(201);
    expect(submitStatusCode(result(WagerTransactionStatus.Processed, true))).toBe(200);
    expect(submitStatusCode(result(WagerTransactionStatus.Rejected, false, FailureCode.InsufficientFunds))).toBe(422);
    expect(submitStatusCode(result(WagerTransactionStatus.Rejected, true, FailureCode.InsufficientFunds))).toBe(422);
    expect(submitStatusCode(result(WagerTransactionStatus.PendingReference))).toBe(202);
    expect(submitStatusCode(result(WagerTransactionStatus.Pending))).toBe(202);
    expect(submitStatusCode(result(WagerTransactionStatus.Failed, false, FailureCode.ProcessingFailed))).toBe(500);
  });
});
