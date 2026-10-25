import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DuplicateMessageError } from '../../application/dto';
import { APP_LOGGER, METRICS, type AppLogger, type Metrics } from '../../application/ports';
import { WageringService } from '../../application/wagering.service';
import { sendToDlq } from './dlq';
import { SQS_SETTINGS } from './messaging.tokens';
import {
  classifyError,
  failureReason,
  parseWagerEnvelope,
  toSubmitCommand,
  type ParsedWagerMessage,
} from './consumer-classification';
import { QueueUrlResolver, SQS_CLIENT, type SqsSettings } from './sqs.config';
import { WorkerLoop, envInt } from './worker-loop';

const MAX_BATCH_SIZE = 10;
const UNGROUPED = '__ungrouped__';
const RECEIVE_BACKOFF_MS = 1_000;
const DLQ_RETRY_SECONDS = 5;
const SHUTDOWN_DRAIN_MS = 10_000;
const MAX_RECEIVES_REASON = 'MAX_RECEIVES_EXCEEDED';

/** Resultado de uma mensagem para o grupo: segue para a próxima, ou segura o restante com `holdSeconds`. */
type GroupOutcome = { proceed: true } | { proceed: false; holdSeconds: number };
const PROCEED: GroupOutcome = { proceed: true };

interface LogCtx {
  messageId?: string;
  correlationId?: string;
  providerId?: string;
  walletId?: string;
}

/**
 * Consome wager-transactions.fifo e aplica o MESMO use case do HTTP (WageringService.submit).
 *  - ack só depois do commit (submit retornou) ou para duplicata/conflito de idempotência;
 *  - mensagens do mesmo MessageGroupId são processadas em ordem; grupos diferentes em paralelo;
 *  - ao falhar de forma transitória num grupo, o restante do grupo é devolvido à fila sem processar,
 *    para não quebrar a ordem;
 *  - em parada, termina as mensagens em andamento e devolve as que ainda não começaram.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log: AppLogger;
  private readonly waitSeconds = envInt('SQS_WAIT_SECONDS', 5);
  private readonly backoffMaxSeconds = envInt('SQS_VISIBILITY_BACKOFF_MAX_S', 60);
  private readonly loop: WorkerLoop;
  private receiveAbort: AbortController | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(QueueUrlResolver) private readonly resolver: QueueUrlResolver,
    @Inject(SQS_SETTINGS) private readonly settings: SqsSettings,
    @Inject(WageringService) private readonly service: WageringService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.log = logger.child({ component: 'sqs-consumer' });
    this.loop = new WorkerLoop(SHUTDOWN_DRAIN_MS, () =>
      this.log.warn('consumer drain timeout; unfinished messages will be redelivered after visibility timeout'),
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED !== 'false') this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.loop.start(
      async (loop) => {
        while (!loop.isStopping) {
          try {
            await this.pollOnce();
          } catch (err) {
            if (loop.isStopping) break;
            this.log.error('receive failed; backing off', { err });
            await loop.sleep(RECEIVE_BACKOFF_MS);
          }
        }
      },
      (err) => this.log.error('consumer loop crashed', { err }),
    );
  }

  async stop(): Promise<void> {
    // Aborta só o long polling; as mensagens já recebidas são concluídas ou devolvidas.
    await this.loop.stop(() => this.receiveAbort?.abort());
  }

  /** Uma leitura (long polling) e o processamento do lote. Retorna quantas mensagens chegaram. */
  async pollOnce(): Promise<number> {
    const abort = new AbortController();
    this.receiveAbort = abort;
    const QueueUrl = await this.resolver.resolve(this.settings.queueName);
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: MAX_BATCH_SIZE,
        WaitTimeSeconds: this.waitSeconds,
        MessageSystemAttributeNames: [
          MessageSystemAttributeName.ApproximateReceiveCount,
          MessageSystemAttributeName.MessageGroupId,
        ],
      }),
      { abortSignal: abort.signal },
    );

    const messages = res.Messages ?? [];
    if (messages.length === 0) return 0;

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.MessageGroupId ?? UNGROUPED;
      const list = groups.get(key);
      if (list) list.push(message);
      else groups.set(key, [message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    return messages.length;
  }

  /**
   * Processa o grupo em ordem. Se uma mensagem segura o grupo (falha transitória ou parada), as seguintes
   * voltam para a fila com o MESMO atraso da cabeça: reaparecem junto dela, nunca antes. Em parada o atraso é 0.
   */
  private async processGroup(group: Message[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      const outcome = await this.handle(message);
      if (!outcome.proceed) {
        for (const rest of group.slice(index + 1)) {
          await this.changeVisibility(rest, outcome.holdSeconds);
        }
        return;
      }
    }
  }

  private async handle(message: Message): Promise<GroupOutcome> {
    if (this.loop.isStopping) {
      await this.changeVisibility(message, 0);
      return { proceed: false, holdSeconds: 0 };
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let parsed: ParsedWagerMessage | undefined;
    try {
      parsed = parseWagerEnvelope(message.Body);
      const command = toSubmitCommand(parsed);
      // Latência e transactionsTotal são registradas pelo próprio use case (source 'sqs').
      const result = await this.service.submit(command);
      this.log.info('wager message processed', {
        messageId: parsed.messageId,
        correlationId: command.correlationId,
        providerId: parsed.data.providerId,
        walletId: parsed.data.walletId,
        transactionId: result.transactionId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (err) {
      return this.handleFailure(message, parsed, err, receiveCount);
    }

    // Commit já ocorreu. Hook de falha: morre antes do delete para exercitar o redelivery.
    if (process.env.FAULT_CRASH_AFTER_COMMIT === '1') {
      this.log.warn('FAULT_CRASH_AFTER_COMMIT: exiting after commit, before delete', { messageId: parsed.messageId });
      process.exit(137);
    }
    await this.deleteMessage(message);
    return PROCEED;
  }

  private async handleFailure(
    message: Message,
    parsed: ParsedWagerMessage | undefined,
    err: unknown,
    receiveCount: number,
  ): Promise<GroupOutcome> {
    const ctx: LogCtx = {
      messageId: parsed?.messageId ?? message.MessageId,
      correlationId: parsed?.data.correlationId ?? parsed?.messageId,
      providerId: parsed?.data.providerId,
      walletId: parsed?.data.walletId,
    };

    switch (classifyError(err)) {
      case 'ack': {
        if (err instanceof DuplicateMessageError) {
          this.metrics.duplicateDetected('sqs');
          this.log.info('duplicate delivery acknowledged', { ...ctx });
        } else {
          this.log.warn('idempotency conflict acknowledged', { ...ctx, reason: failureReason(err) });
        }
        await this.deleteMessage(message);
        return PROCEED;
      }
      case 'dlq':
        return this.moveToDlq(message, failureReason(err), ctx, err);
      case 'retry': {
        if (receiveCount >= this.settings.maxReceives) {
          return this.moveToDlq(message, MAX_RECEIVES_REASON, ctx, err);
        }
        const delaySeconds = Math.min(2 ** receiveCount, this.backoffMaxSeconds);
        this.metrics.retry('sqs');
        this.log.warn('transient failure; message will be retried', {
          ...ctx,
          reason: failureReason(err),
          receiveCount,
          delaySeconds,
          err,
        });
        await this.changeVisibility(message, delaySeconds);
        return { proceed: false, holdSeconds: delaySeconds };
      }
    }
  }

  private async moveToDlq(message: Message, reason: string, ctx: LogCtx, err: unknown): Promise<GroupOutcome> {
    try {
      await sendToDlq(this.client, this.resolver, this.settings, message, reason);
    } catch (dlqErr) {
      // Sem DLQ não se apaga a original: devolve à fila e tenta de novo.
      this.log.error('could not send message to DLQ; will retry', { ...ctx, reason, err: dlqErr });
      await this.changeVisibility(message, DLQ_RETRY_SECONDS);
      return { proceed: false, holdSeconds: DLQ_RETRY_SECONDS };
    }
    this.metrics.dlqMessage(reason);
    this.log.error('message moved to DLQ', { ...ctx, reason, err });
    await this.deleteMessage(message);
    return PROCEED;
  }

  private async deleteMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      const QueueUrl = await this.resolver.resolve(this.settings.queueName);
      await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (err) {
      // Commit já feito: se a entrega voltar, a inbox responde DuplicateMessageError e o ack acontece.
      this.log.warn('delete failed; message will be redelivered and deduplicated', { messageId: message.MessageId, err });
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      const QueueUrl = await this.resolver.resolve(this.settings.queueName);
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (err) {
      this.log.warn('could not change message visibility', { messageId: message.MessageId, seconds, err });
    }
  }
}
