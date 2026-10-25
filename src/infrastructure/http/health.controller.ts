import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SQS_CLIENT, sqsSettingsFromEnv } from '../messaging/sqs.config';
import { Public } from './auth';

const CHECK_TIMEOUT_MS = 2000;

export type CheckState = 'up' | 'down';

export interface ReadinessBody {
  status: 'ok' | 'error';
  checks: { postgres: CheckState; sqs: CheckState };
}

/** Rejeita se o trabalho não terminar em `ms`. O timer é limpo quando o trabalho termina. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Liveness: processo respondendo. Readiness: PostgreSQL e SQS alcançáveis agora.
 * SQS usa GetQueueUrl direto (sem cache do QueueUrlResolver), para que uma queda seja vista na próxima checagem.
 * Ambos os endpoints são @Public(): não exigem autenticação.
 */
@Controller('health')
export class HealthController {
  private readonly queueName = sqsSettingsFromEnv().queueName;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessBody> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const healthy = postgres === 'up' && sqs === 'up';
    res.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'error', checks: { postgres, sqs } };
  }

  private checkPostgres(): Promise<CheckState> {
    const probe = this.em.fork().getConnection().execute('select 1');
    return withTimeout(probe, CHECK_TIMEOUT_MS).then(
      (): CheckState => 'up',
      (): CheckState => 'down',
    );
  }

  private checkSqs(): Promise<CheckState> {
    const probe = this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    return withTimeout(probe, CHECK_TIMEOUT_MS).then(
      (out): CheckState => (out.QueueUrl ? 'up' : 'down'),
      (): CheckState => 'down',
    );
  }
}
