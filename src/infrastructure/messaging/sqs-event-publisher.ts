import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EventPublisher } from '../../application/ports';
import { SQS_SETTINGS } from './messaging.tokens';
import { QueueUrlResolver, SQS_CLIENT, type SqsSettings } from './sqs.config';

/**
 * Publica eventos de integração em wager-events.fifo.
 * MessageGroupId = aggregateId (walletId) preserva a ordem por wallet;
 * MessageDeduplicationId = eventId absorve republicações dentro da janela de 5 min do FIFO.
 * Após a janela, a deduplicação fica a cargo do consumidor (eventId).
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(QueueUrlResolver) private readonly resolver: QueueUrlResolver,
    @Inject(SQS_SETTINGS) private readonly settings: SqsSettings,
  ) {}

  async publish(message: Parameters<EventPublisher['publish']>[0]): Promise<void> {
    const QueueUrl = await this.resolver.resolve(this.settings.eventsQueueName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
