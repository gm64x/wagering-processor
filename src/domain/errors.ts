/** Base de todos os erros de domínio. `code` é estável e pode ser exposto/mapeado. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends DomainError {
  override readonly code = 'INVALID_TRANSACTION_STATE';
}

/** Payload/entrada inválida em nível de domínio (400 / DLQ). */
export class ValidationError extends DomainError {
  override readonly code = 'VALIDATION_ERROR';
}

/** Lançamento de ledger que viola uma invariante (valor não positivo, saldo negativo, etc.). */
export class InvalidLedgerEntryError extends DomainError {
  override readonly code = 'INVALID_LEDGER_ENTRY';
}
