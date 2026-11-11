import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Financial invariants are enforced by the database itself, independently of the
 * application: CHECKs, UNIQUEs, partial unique indexes and triggers. Trigger errors use SQLSTATE
 * 23000 (integrity_constraint_violation) and carry the guard name both in the message and in the
 * `constraint` field, like a native constraint violation.
 */
export class Migration20261111000000Initial extends Migration {
  override up(): void {
    this.createTables();
    this.createIndexes();
    this.createWalletGuards();
    this.createLedgerGuards();
    this.createTransactionGuard();
    this.createOutboxGuard();
  }

  override down(): void {
    this.addSql(`DROP TRIGGER outbox_guard ON outbox_messages;`);
    this.addSql(`DROP TRIGGER wager_transactions_guard ON wager_transactions;`);
    this.addSql(`DROP TRIGGER ledger_append_only_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER ledger_append_only ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER ledger_chain_guard ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER wallets_ledger_consistency ON wallets;`);
    this.addSql(`DROP TRIGGER wallets_version_guard ON wallets;`);

    this.addSql(`DROP FUNCTION outbox_guard();`);
    this.addSql(`DROP FUNCTION wager_transactions_guard();`);
    this.addSql(`DROP FUNCTION ledger_append_only();`);
    this.addSql(`DROP FUNCTION ledger_chain_guard();`);
    this.addSql(`DROP FUNCTION wallets_ledger_consistency();`);
    this.addSql(`DROP FUNCTION wallets_version_guard();`);

    this.addSql(`DROP INDEX outbox_messages_due_idx;`);
    this.addSql(`DROP INDEX wager_transactions_pending_reference_due_idx;`);
    this.addSql(`DROP INDEX wager_transactions_provider_reference_idx;`);
    this.addSql(`DROP INDEX wager_transactions_wallet_id_idx;`);
    this.addSql(`DROP INDEX wager_transactions_single_reversal_key;`);

    this.addSql(`DROP TABLE outbox_messages;`);
    this.addSql(`DROP TABLE inbox_messages;`);
    this.addSql(`DROP TABLE wallet_ledger_entries;`);
    this.addSql(`DROP TABLE wager_transactions;`);
    this.addSql(`DROP TABLE wallets;`);
  }

  private createTables(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_check CHECK (balance >= 0),
        CONSTRAINT wallets_version_check CHECK (version >= 1),
        CONSTRAINT wallets_player_id_currency_key UNIQUE (player_id, currency)
      );`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        text          NOT NULL,
        external_transaction_id            text          NOT NULL,
        idempotency_key                    text          NOT NULL,
        payload_hash                       char(64)      NOT NULL,
        wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
        player_id                          uuid          NOT NULL,
        round_id                           text          NULL,
        game_id                            text          NULL,
        kind                               text          NOT NULL,
        amount                             numeric(20,2) NOT NULL,
        currency                           char(3)       NOT NULL,
        reference_external_transaction_id  text          NULL,
        reference_transaction_id           uuid          NULL REFERENCES wager_transactions (id),
        status                             text          NOT NULL,
        failure_code                       text          NULL,
        observed_balance                   numeric(20,2) NULL,
        attempts                           integer       NOT NULL DEFAULT 0,
        next_attempt_at                    timestamptz   NULL,
        processed_at                       timestamptz   NULL,
        created_at                         timestamptz   NOT NULL,
        updated_at                         timestamptz   NOT NULL,
        CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_id_external_transaction_id_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_transactions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_amount_check CHECK (amount > 0),
        CONSTRAINT wager_transactions_attempts_check CHECK (attempts >= 0),
        CONSTRAINT wager_transactions_kind_check
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_check
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_failure_code_check CHECK (failure_code IN (
          'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'BALANCE_LIMIT_EXCEEDED', 'CURRENCY_MISMATCH',
          'PLAYER_WALLET_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'REFERENCE_KIND_NOT_ALLOWED',
          'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REVERSED', 'REFERENCE_NOT_REVERSIBLE',
          'INTERNAL_PROCESSING_ERROR'
        )),
        -- Only the internal OPENING transaction lives outside a game round.
        CONSTRAINT wager_transactions_round_game_check
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_transactions_reference_required_check
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- Lifecycle columns mirror the status exactly (see WagerTransaction transitions).
        CONSTRAINT wager_transactions_failure_code_status_check
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_status_check
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_next_attempt_at_status_check
          CHECK ((status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL)),
        -- Decisions record the balance they observed, so a replay returns the original answer.
        CONSTRAINT wager_transactions_observed_balance_check CHECK (
          (observed_balance IS NULL OR observed_balance >= 0)
          AND (status NOT IN ('PROCESSED', 'REJECTED') OR observed_balance IS NOT NULL)
        )
      );`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL REFERENCES wallets (id),
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
        direction       text          NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        wallet_version  integer       NOT NULL,
        created_at      timestamptz   NOT NULL,
        CONSTRAINT wallet_ledger_entries_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_check CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallet_ledger_entries_balance_after_check CHECK (balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_wallet_version_check CHECK (wallet_version >= 1),
        CONSTRAINT wallet_ledger_entries_arithmetic_check CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
        ),
        CONSTRAINT wallet_ledger_entries_wallet_id_transaction_id_key UNIQUE (wallet_id, transaction_id),
        -- Also the index behind chain lookups and keyset pagination by wallet_version.
        CONSTRAINT wallet_ledger_entries_wallet_id_wallet_version_key UNIQUE (wallet_id, wallet_version)
      );`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   char(64)    NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz NULL,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_messages_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      );`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        aggregate_id     uuid        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz NULL,
        published_at     timestamptz NULL,
        CONSTRAINT outbox_messages_attempts_check CHECK (attempts >= 0),
        -- A pending message must be reachable by the publisher's due-index scan.
        CONSTRAINT outbox_messages_next_attempt_at_check CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL)
      );`);
  }

  private createIndexes(): void {
    // A transaction is reversed at most once, whatever the reversal kind (REFUND or ROLLBACK).
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal_key
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';`);
    this.addSql(`CREATE INDEX wager_transactions_wallet_id_idx ON wager_transactions (wallet_id);`);
    this.addSql(`
      CREATE INDEX wager_transactions_provider_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id);`);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due_idx
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX outbox_messages_due_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;`);
  }

  private createWalletGuards(): void {
    this.addSql(`
      CREATE FUNCTION wallets_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallets_version_guard: id, player_id, currency and created_at of wallet % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallets_version_guard', TABLE = TG_TABLE_NAME;
        END IF;
        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
            RAISE EXCEPTION 'wallets_version_guard: balance change of wallet % must bump version from % to %, got %',
                OLD.id, OLD.version, OLD.version + 1, NEW.version
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallets_version_guard', TABLE = TG_TABLE_NAME;
          END IF;
        ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'wallets_version_guard: version of wallet % cannot change without a balance change', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallets_version_guard', TABLE = TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wallets_version_guard
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_version_guard();`);

    // Deferred to COMMIT so the wallet update and its ledger entry can be written in any order.
    // It re-reads the wallet: with several moves in one transaction, the final state is what must match.
    this.addSql(`
      CREATE FUNCTION wallets_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_balance numeric(20,2);
        current_version integer;
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.balance = 0 THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.balance = OLD.balance THEN
          RETURN NULL;
        END IF;
        SELECT balance, version INTO current_balance, current_version FROM wallets WHERE id = NEW.id;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id AND wallet_version = current_version AND balance_after = current_balance
        ) THEN
          RAISE EXCEPTION 'wallets_ledger_consistency: wallet % has balance % at version % without a matching ledger entry',
              NEW.id, current_balance, current_version
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallets_ledger_consistency', TABLE = TG_TABLE_NAME;
        END IF;
        RETURN NULL;
      END;
      $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_ledger_consistency();`);
  }

  private createLedgerGuards(): void {
    // The chain starts at version 1 (wallet opened with balance > 0) or 2 (opened with zero) from a
    // zero balance and continues without gaps, each entry starting where the previous one ended.
    this.addSql(`
      CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_balance_after numeric(20,2);
      BEGIN
        SELECT balance_after INTO previous_balance_after
        FROM wallet_ledger_entries
        WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF FOUND THEN
          IF NEW.balance_before <> previous_balance_after THEN
            RAISE EXCEPTION 'ledger_chain_guard: entry % of wallet % starts at % but version % ended at %',
                NEW.wallet_version, NEW.wallet_id, NEW.balance_before, NEW.wallet_version - 1, previous_balance_after
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_chain_guard', TABLE = TG_TABLE_NAME;
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.wallet_version NOT IN (1, 2)
           OR NEW.balance_before <> 0
           OR EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id) THEN
          RAISE EXCEPTION 'ledger_chain_guard: entry % of wallet % has no predecessor and is not a valid chain start (version 1 or 2 from balance 0)',
              NEW.wallet_version, NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_chain_guard', TABLE = TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER ledger_chain_guard
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard();`);

    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_append_only: % on wallet_ledger_entries is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_append_only', TABLE = TG_TABLE_NAME;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only();`);
    this.addSql(`
      CREATE TRIGGER ledger_append_only_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();`);
  }

  private createTransactionGuard(): void {
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager_transactions_guard: transaction % is % (terminal) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_transactions_guard', TABLE = TG_TABLE_NAME;
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager_transactions_guard: business fields of transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_transactions_guard', TABLE = TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();`);
  }

  private createOutboxGuard(): void {
    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox_guard: event % is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'outbox_guard', TABLE = TG_TABLE_NAME;
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox_guard: event % was published at % and cannot be unpublished or republished',
              OLD.id, OLD.published_at
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'outbox_guard', TABLE = TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER outbox_guard
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard();`);
  }
}
