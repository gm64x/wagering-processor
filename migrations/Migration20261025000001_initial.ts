import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras vivem AQUI, não só no código:
 *  - unicidade: wallet por (player, currency); idempotency_key; (provider, external_id);
 *    um lançamento por (transaction, wallet); uma reversão por referência; inbox por (consumer, message)
 *  - não-negatividade: CHECK balance >= 0; CHECK amount > 0 no ledger
 *  - aritmética do ledger: CHECK balance_after = balance_before ± amount
 *  - imutabilidade: triggers bloqueiam UPDATE/DELETE no ledger e mudanças em transações terminais
 * Dinheiro: NUMERIC(20,2) + CHAR(3). Nunca float.
 */
export class Migration20261025000001_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallets (
  id              uuid PRIMARY KEY,
  player_id       uuid NOT NULL,
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_amount  numeric(20,2) NOT NULL CHECK (balance_amount >= 0),
  version         integer NOT NULL CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);`);

    this.addSql(`
CREATE TABLE wager_transactions (
  id                                 uuid PRIMARY KEY,
  provider_id                        text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  external_transaction_id            text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 256),
  idempotency_key                    text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  payload_hash                       char(64) NOT NULL,
  wallet_id                          uuid NOT NULL REFERENCES wallets(id),
  player_id                          uuid NOT NULL,
  round_id                           text NOT NULL,
  game_id                            text NOT NULL,
  kind                               text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                           char(3) NOT NULL,
  reference_external_transaction_id  text NULL,
  reference_transaction_id           uuid NULL REFERENCES wager_transactions(id),
  status                             text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                       text NULL,
  -- saldo observado quando a transação atingiu o estado final (replay devolve este valor)
  result_balance_amount              numeric(20,2) NULL CHECK (result_balance_amount >= 0),
  attempts                           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at                    timestamptz NULL,
  correlation_id                     text NULL,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  processed_at                       timestamptz NULL,
  updated_at                         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_wtx_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_wtx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT ck_wtx_reference_required CHECK (
    kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_wtx_rejected_has_code CHECK (
    status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
  CONSTRAINT ck_wtx_processed_has_ts CHECK (
    status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CONSTRAINT ck_wtx_opening_internal CHECK (
    kind <> 'OPENING' OR provider_id = 'internal')
);`);
    // resolução de referência por (provider, external_id) já coberta por uq_wtx_provider_external
    // uma referência só pode ser revertida (REFUND ou ROLLBACK) uma única vez — evita crédito duplo
    this.addSql(`CREATE UNIQUE INDEX uq_wtx_single_reversal ON wager_transactions (reference_transaction_id)
      WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';`);
    // fila do worker de pending reference
    this.addSql(`CREATE INDEX ix_wtx_pending_reference_due ON wager_transactions (next_attempt_at)
      WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX ix_wtx_wallet ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
CREATE TABLE wallet_ledger_entries (
  seq                    bigserial UNIQUE,
  id                     uuid PRIMARY KEY,
  wallet_id              uuid NOT NULL REFERENCES wallets(id),
  transaction_id         uuid NOT NULL REFERENCES wager_transactions(id),
  direction              text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount                 numeric(20,2) NOT NULL CHECK (amount > 0),
  currency               char(3) NOT NULL,
  balance_before_amount  numeric(20,2) NOT NULL CHECK (balance_before_amount >= 0),
  balance_after_amount   numeric(20,2) NOT NULL CHECK (balance_after_amount >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_tx_wallet UNIQUE (transaction_id, wallet_id),
  CONSTRAINT ck_ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + amount) OR
    (direction = 'DEBIT'  AND balance_after_amount = balance_before_amount - amount))
);`);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'P0001';
END $$;`);
    this.addSql(`CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();`);
    this.addSql(`CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();`);

    this.addSql(`
CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.kind <> OLD.kind
     OR NEW.wallet_id <> OLD.wallet_id THEN
    RAISE EXCEPTION 'immutable columns of wager transaction % cannot change', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER trg_wtx_guard BEFORE UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();`);
    this.addSql(`CREATE TRIGGER trg_wtx_no_delete BEFORE DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();`);

    this.addSql(`
CREATE TABLE inbox_messages (
  consumer_name  text NOT NULL,
  message_id     text NOT NULL,
  payload_hash   char(64) NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz NULL,
  PRIMARY KEY (consumer_name, message_id)
);`);

    this.addSql(`
CREATE TABLE outbox_messages (
  id               uuid PRIMARY KEY,
  aggregate_id     text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz NULL,
  last_error       text NULL
);`);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_mutation();');
    this.addSql('DROP FUNCTION IF EXISTS guard_wager_transaction_update();');
  }
}
