import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export interface SqsSettings {
  endpoint: string;
  region: string;
  queueName: string;
  dlqName: string;
  eventsQueueName: string;
  maxReceives: number;
}

export function sqsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SqsSettings {
  return {
    endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: env.AWS_REGION ?? 'us-east-1',
    queueName: env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
    dlqName: env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
    maxReceives: Number(env.SQS_MAX_RECEIVES ?? 5),
  };
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 3,
  });
}

/** Resolve e memoriza URLs de fila (GetQueueUrl). */
export class QueueUrlResolver {
  private readonly cache = new Map<string, Promise<string>>();
  constructor(private readonly client: SQSClient) {}

  resolve(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.client
        .send(new GetQueueUrlCommand({ QueueName: queueName }))
        .then((r) => {
          if (!r.QueueUrl) throw new Error(`queue ${queueName} not found`);
          return r.QueueUrl;
        })
        .catch((e: unknown) => {
          this.cache.delete(queueName);
          throw e;
        });
      this.cache.set(queueName, url);
    }
    return url;
  }
}
