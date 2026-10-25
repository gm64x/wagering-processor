import './env';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageBatchCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { SQS_ENDPOINT } from './env';
import { sleep, waitFor } from './wait';

export const sqs = new SQSClient({
  endpoint: SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export interface TestQueues {
  suffix: string;
  mainName: string;
  dlqName: string;
  eventsName: string;
  mainUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  /** variáveis de env que apontam um app / processo filho para estas filas */
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface QueueOptions {
  visibilityTimeout?: number;
  /** Redrive nativo do SQS (o app também move para a DLQ sozinho em SQS_MAX_RECEIVES). */
  redriveMaxReceiveCount?: number;
  maxReceives?: number;
}

/**
 * Filas FIFO dedicadas, com nomes aleatórios (principal + DLQ + eventos) para um arquivo de teste, para que
 * arquivos e execuções nunca vejam as mensagens uns dos outros. Espelha a topologia de produção (redrive policy para a DLQ).
 */
export async function createTestQueues(opts: QueueOptions = {}): Promise<TestQueues> {
  const suffix = randomUUID().slice(0, 8);
  const mainName = `t-${suffix}-wager-transactions.fifo`;
  const dlqName = `t-${suffix}-wager-transactions-dlq.fifo`;
  const eventsName = `t-${suffix}-wager-events.fifo`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: fifo }))).QueueUrl!;
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  const mainUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: mainName,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(opts.visibilityTimeout ?? 3),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: String(opts.redriveMaxReceiveCount ?? 5),
          }),
        },
      }),
    )
  ).QueueUrl!;
  const eventsUrl = (await sqs.send(new CreateQueueCommand({ QueueName: eventsName, Attributes: fifo }))).QueueUrl!;

  return {
    suffix,
    mainName,
    dlqName,
    eventsName,
    mainUrl,
    dlqUrl,
    eventsUrl,
    env: {
      SQS_QUEUE_NAME: mainName,
      SQS_DLQ_NAME: dlqName,
      SQS_EVENTS_QUEUE_NAME: eventsName,
      SQS_MAX_RECEIVES: String(opts.maxReceives ?? 5),
    },
    async cleanup() {
      for (const QueueUrl of [mainUrl, dlqUrl, eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      }
    },
  };
}

export interface WagerMessageData {
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
}

export function wagerEnvelope(data: WagerMessageData, messageId: string = randomUUID()): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  });
}

/** MessageGroupId = walletId mantém a ordem por wallet, como um producer real faria. */
export async function sendWager(
  queueUrl: string,
  data: WagerMessageData,
  messageId: string = randomUUID(),
  dedupId: string = randomUUID(),
): Promise<string> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: wagerEnvelope(data, messageId),
      MessageGroupId: data.walletId,
      MessageDeduplicationId: dedupId,
    }),
  );
  return messageId;
}

export async function sendRaw(queueUrl: string, body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

/** Envio em lote (10 por chamada) para testes de carga. A ordem dentro de um grupo segue a ordem do array. */
export async function sendWagerBatch(queueUrl: string, items: Array<{ data: WagerMessageData; messageId?: string; groupId?: string }>): Promise<void> {
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const res = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((it, j) => ({
          Id: String(j),
          MessageBody: wagerEnvelope(it.data, it.messageId ?? randomUUID()),
          MessageGroupId: it.groupId ?? it.data.walletId,
          MessageDeduplicationId: randomUUID(),
        })),
      }),
    );
    if (res.Failed?.length) throw new Error(`send batch failed: ${JSON.stringify(res.Failed)}`);
  }
}

export interface QueueCounts {
  visible: number;
  inFlight: number;
  delayed: number;
}

export async function queueCounts(queueUrl: string): Promise<QueueCounts> {
  const a = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    )
  ).Attributes!;
  return {
    visible: Number(a.ApproximateNumberOfMessages),
    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible),
    delayed: Number(a.ApproximateNumberOfMessagesDelayed),
  };
}

export async function queueTotal(queueUrl: string): Promise<number> {
  const c = await queueCounts(queueUrl);
  return c.visible + c.inFlight + c.delayed;
}

/** Espera até não haver nada visível, em voo ou atrasado (a mensagem foi apagada, não só oculta). */
export async function waitQueueEmpty(queueUrl: string, timeoutMs = 60_000): Promise<void> {
  let stable = 0;
  await waitFor(
    async () => {
      stable = (await queueTotal(queueUrl)) === 0 ? stable + 1 : 0;
      return stable >= 2; // duas leituras vazias seguidas: os atributos são aproximados
    },
    timeoutMs,
    `queue ${queueUrl} to be empty`,
    300,
  );
}

/** Recebe (e apaga) mensagens até `isDone(all)` ser verdadeiro ou `timeoutMs` expirar. Retorna tudo que foi recebido. */
export async function drainMessages(
  queueUrl: string,
  opts: { isDone?: (all: Message[]) => boolean; timeoutMs?: number; quietMs?: number } = {},
): Promise<Message[]> {
  const all: Message[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let doneAt: number | undefined;
  while (Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    const msgs = res.Messages ?? [];
    if (msgs.length > 0) {
      all.push(...msgs);
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
        }),
      );
      doneAt = undefined;
      continue;
    }
    if (opts.isDone?.(all)) {
      // fica mais um pouco para pegar duplicatas que ainda estariam a caminho
      doneAt ??= Date.now();
      if (Date.now() - doneAt >= (opts.quietMs ?? 1500)) break;
    }
    await sleep(50);
  }
  return all;
}

export interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, any>;
}

export function parseEvents(messages: Message[]): EventEnvelope[] {
  return messages.map((m) => JSON.parse(m.Body!) as EventEnvelope);
}
