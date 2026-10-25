import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { ApplicationModule } from '../../application/application.module';
import { EVENT_PUBLISHER } from '../../application/ports';
import { OutboxPublisher } from './outbox-publisher';
import { SqsEventPublisher } from './sqs-event-publisher';
import { SQS_SETTINGS } from './messaging.tokens';
import { WagerTransactionConsumer } from './wager-transaction.consumer';
import { QueueUrlResolver, SQS_CLIENT, createSqsClient, sqsSettingsFromEnv, type SqsSettings } from './sqs.config';

/**
 * Infraestrutura de mensageria: cliente SQS, publicação de eventos, outbox e consumidor.
 * Os loops de worker só iniciam quando WORKERS_ENABLED !== 'false' (ver OnApplicationBootstrap das classes).
 */
@Module({
  imports: [ApplicationModule],
  providers: [
    { provide: SQS_SETTINGS, useFactory: (): SqsSettings => sqsSettingsFromEnv() },
    {
      provide: SQS_CLIENT,
      useFactory: (settings: SqsSettings): SQSClient => createSqsClient(settings),
      inject: [SQS_SETTINGS],
    },
    {
      provide: QueueUrlResolver,
      useFactory: (client: SQSClient): QueueUrlResolver => new QueueUrlResolver(client),
      inject: [SQS_CLIENT],
    },
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    OutboxPublisher,
    WagerTransactionConsumer,
  ],
  exports: [SQS_CLIENT, SQS_SETTINGS, QueueUrlResolver, OutboxPublisher, WagerTransactionConsumer, EVENT_PUBLISHER],
})
export class MessagingModule {}
