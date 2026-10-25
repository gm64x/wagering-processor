import { ValidationError } from './errors';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Registro de idempotência de mensagens recebidas (chave: consumidor + messageId). */
export class InboxMessage {
  private state: InboxMessageState;

  private constructor(state: InboxMessageState) {
    this.state = state;
  }

  static receive(p: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
  }): InboxMessage {
    if (p.messageId.length === 0 || p.consumerName.length === 0) {
      throw new ValidationError('messageId and consumerName are required');
    }
    if (!SHA256_HEX.test(p.payloadHash)) {
      throw new ValidationError('payloadHash must be a sha256 hex digest');
    }
    return new InboxMessage({
      consumerName: p.consumerName,
      messageId: p.messageId,
      payloadHash: p.payloadHash,
      receivedAt: p.receivedAt,
    });
  }

  /** Não valida: reconstrói o estado persistido tal como está. */
  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...s });
  }

  get consumerName(): string {
    return this.state.consumerName;
  }

  get messageId(): string {
    return this.state.messageId;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get receivedAt(): Date {
    return this.state.receivedAt;
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt;
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this.state.processedAt = at;
  }

  toState(): InboxMessageState {
    return { ...this.state };
  }
}
