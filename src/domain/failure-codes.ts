/** Taxonomia estável de motivos de rejeição/falha de uma transação. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET sem saldo — provedor não deve reenviar igual
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK que deixaria saldo negativo
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // referência nunca chegou (esgotou retries)
  ReferenceMismatch = 'REFERENCE_MISMATCH', // provider/player/wallet/moeda/rodada diferentes
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND', // REFUND->não-BET, ROLLBACK->LOSS/OPENING/ROLLBACK, WIN->não-BET
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // referência REJECTED/FAILED
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH', // REFUND/ROLLBACK com valor != referência
  ProcessingFailed = 'PROCESSING_FAILED', // usado só com status FAILED
}
