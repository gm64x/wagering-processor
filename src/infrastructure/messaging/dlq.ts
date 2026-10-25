import { SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { QueueUrlResolver, SqsSettings } from './sqs.config';

/**
 * Copia a mensagem original para a DLQ FIFO, preservando o MessageGroupId de origem.
 * A deduplicação usa o MessageId SQS original: reenvios da mesma entrega não duplicam na DLQ (janela de 5 min).
 * Lança se o envio falhar; quem chama NÃO deve apagar a original nesse caso.
 */
export async function sendToDlq(
  client: SQSClient,
  resolver: QueueUrlResolver,
  settings: SqsSettings,
  original: Message,
  reason: string,
): Promise<void> {
  const QueueUrl = await resolver.resolve(settings.dlqName);
  await client.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: original.Body ?? '',
      MessageGroupId: original.Attributes?.MessageGroupId ?? 'dlq',
      MessageDeduplicationId: original.MessageId ?? randomUUID(),
      MessageAttributes: {
        reason: { DataType: 'String', StringValue: reason },
        sourceQueue: { DataType: 'String', StringValue: settings.queueName },
      },
    }),
  );
}
