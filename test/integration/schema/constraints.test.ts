import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../../support/db';

const T0 = new Date('2026-11-11T00:00:00Z');
const uuid = () => crypto.randomUUID();

type Row = Record<string, unknown>;

interface WalletRow extends Row {
  id: string;
  player_id: string;
}

interface TxRow extends Row {
  id: string;
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(() => db.drop());

function walletRow(overrides: Row = {}): WalletRow {
  return {
    id: uuid(),
    player_id: uuid(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  } as WalletRow;
}

function txRow(wallet: WalletRow, overrides: Row = {}): TxRow {
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: `ext-${uuid()}`,
    idempotency_key: `idem-${uuid()}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: T0,
    updated_at: T0,
    ...overrides,
  } as TxRow;
}

function processed(overrides: Row = {}): Row {
  return { status: 'PROCESSED', processed_at: T0, observed_balance: '0.00', ...overrides };
}

interface EntryProps {
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  before: string;
  after: string;
  version: number;
}

function entryRow(walletId: string, transactionId: string, e: EntryProps): Row {
  return {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: e.direction,
    amount: e.amount,
    currency: 'BRL',
    balance_before: e.before,
    balance_after: e.after,
    wallet_version: e.version,
    created_at: T0,
  };
}

async function insertTx(sql: SQL, row: TxRow): Promise<TxRow> {
  await sql`INSERT INTO wager_transactions ${sql(row)}`;
  return row;
}

async function insertEntry(sql: SQL, row: Row): Promise<void> {
  await sql`INSERT INTO wallet_ledger_entries ${sql(row)}`;
}

/** Inserts a wallet the way OpenWallet does: an OPENING transaction and a version-1 entry when balance > 0. */
async function openWallet(balance = '0.00', overrides: Row = {}): Promise<WalletRow> {
  const wallet = walletRow({ balance, ...overrides });
  await db.sql.begin(async (tx) => {
    await tx`INSERT INTO wallets ${tx(wallet)}`;
    if (balance === '0.00') return;
    const opening = txRow(wallet, {
      kind: 'OPENING',
      provider_id: 'internal',
      round_id: null,
      game_id: null,
      amount: balance,
      ...processed({ observed_balance: balance }),
    });
    await insertTx(tx, opening);
    await insertEntry(tx, entryRow(wallet.id, opening.id, { direction: 'CREDIT', amount: balance, before: '0.00', after: balance, version: 1 }));
  });
  return wallet;
}

/** Moves the wallet balance together with its ledger entry, inside the caller's transaction. */
async function move(sql: SQL, wallet: WalletRow, txId: string, e: EntryProps): Promise<void> {
  await sql`UPDATE wallets SET balance = ${e.after}, version = ${e.version} WHERE id = ${wallet.id}`;
  await insertEntry(sql, entryRow(wallet.id, txId, e));
}

async function walletState(id: string): Promise<{ balance: string; version: number }> {
  const [row] = await db.sql`SELECT balance, version FROM wallets WHERE id = ${id}`;
  return row;
}

describe('wallets', () => {
  test('wallet balance cannot be negative', async () => {
    const wallet = await openWallet();
    await expect(db.sql`UPDATE wallets SET balance = -1, version = 2 WHERE id = ${wallet.id}`).rejects.toThrow(
      /wallets_balance_check/,
    );
  });

  test('one wallet per player + currency', async () => {
    const wallet = await openWallet();
    await expect(openWallet('0.00', { player_id: wallet.player_id })).rejects.toThrow(/wallets_player_id_currency_key/);
    await openWallet('0.00', { player_id: wallet.player_id, currency: 'USD' });
  });

  test('wallet currency must be three uppercase letters', async () => {
    await expect(openWallet('0.00', { currency: 'brl' })).rejects.toThrow(/wallets_currency_check/);
  });

  test('wallet balance change without ledger entry fails at commit', async () => {
    const wallet = await openWallet();
    const conn = await db.sql.reserve();
    try {
      await conn`BEGIN`;
      // The check is deferred: the statement itself succeeds…
      await conn`UPDATE wallets SET balance = 10, version = 2 WHERE id = ${wallet.id}`;
      // …and the transaction is refused at COMMIT.
      await expect(conn`COMMIT`).rejects.toThrow(/wallets_ledger_consistency/);
    } finally {
      conn.release();
    }
    expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 1 });

    // A wallet born with balance > 0 needs its opening entry as well.
    await expect(db.sql`INSERT INTO wallets ${db.sql(walletRow({ balance: '50.00' }))}`).rejects.toThrow(
      /wallets_ledger_consistency/,
    );
  });

  test('wallet version must bump iff balance changes', async () => {
    const wallet = await openWallet('100.00');
    await expect(db.sql`UPDATE wallets SET version = 2 WHERE id = ${wallet.id}`).rejects.toThrow(/wallets_version_guard/);
    await expect(db.sql`UPDATE wallets SET balance = 90 WHERE id = ${wallet.id}`).rejects.toThrow(/wallets_version_guard/);
    await expect(db.sql`UPDATE wallets SET balance = 90, version = 3 WHERE id = ${wallet.id}`).rejects.toThrow(
      /wallets_version_guard/,
    );
    await expect(db.sql`UPDATE wallets SET player_id = ${uuid()} WHERE id = ${wallet.id}`).rejects.toThrow(
      /wallets_version_guard/,
    );
    await expect(db.sql`UPDATE wallets SET currency = 'USD' WHERE id = ${wallet.id}`).rejects.toThrow(/wallets_version_guard/);
    await expect(db.sql`UPDATE wallets SET created_at = now() WHERE id = ${wallet.id}`).rejects.toThrow(
      /wallets_version_guard/,
    );
    // Touching only updated_at is allowed and keeps the version.
    await db.sql`UPDATE wallets SET updated_at = now() WHERE id = ${wallet.id}`;
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('wallet_ledger_entries', () => {
  test('ledger entries cannot be updated, deleted or truncated', async () => {
    const wallet = await openWallet('100.00');
    await expect(db.sql`UPDATE wallet_ledger_entries SET created_at = now() WHERE wallet_id = ${wallet.id}`).rejects.toThrow(
      /ledger_append_only/,
    );
    await expect(db.sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`).rejects.toThrow(
      /ledger_append_only/,
    );
    await expect(db.sql`TRUNCATE wallet_ledger_entries`).rejects.toThrow(/ledger_append_only/);
    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`;
    expect(count).toBe(1);
  });

  test('ledger arithmetic is checked', async () => {
    const wallet = await openWallet('100.00');
    const win = await insertTx(db.sql, txRow(wallet, { kind: 'WIN' }));
    await expect(
      insertEntry(db.sql, entryRow(wallet.id, win.id, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '120.00', version: 2 })),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic_check/);
    await expect(
      insertEntry(db.sql, entryRow(wallet.id, win.id, { direction: 'DEBIT', amount: '10.00', before: '100.00', after: '110.00', version: 2 })),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic_check/);
    await expect(
      insertEntry(db.sql, entryRow(wallet.id, win.id, { direction: 'CREDIT', amount: '0.00', before: '100.00', after: '100.00', version: 2 })),
    ).rejects.toThrow(/wallet_ledger_entries_amount_check/);
  });

  test('ledger chain must continue from previous balance_after', async () => {
    const funded = await openWallet('100.00');
    const win = await insertTx(db.sql, txRow(funded, { kind: 'WIN' }));
    // balance_before differs from the previous entry's balance_after
    await expect(
      insertEntry(db.sql, entryRow(funded.id, win.id, { direction: 'CREDIT', amount: '10.00', before: '50.00', after: '60.00', version: 2 })),
    ).rejects.toThrow(/ledger_chain_guard/);
    // gap in the version sequence
    await expect(
      insertEntry(db.sql, entryRow(funded.id, win.id, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00', version: 3 })),
    ).rejects.toThrow(/ledger_chain_guard/);
    // a second chain start for a wallet that already has entries
    await expect(
      insertEntry(db.sql, entryRow(funded.id, win.id, { direction: 'CREDIT', amount: '10.00', before: '0.00', after: '10.00', version: 1 })),
    ).rejects.toThrow(/ledger_chain_guard/);

    const empty = await openWallet();
    const credit = await insertTx(db.sql, txRow(empty, { kind: 'WIN' }));
    // the first entry of a chain must start from zero
    await expect(
      insertEntry(db.sql, entryRow(empty.id, credit.id, { direction: 'CREDIT', amount: '10.00', before: '5.00', after: '15.00', version: 2 })),
    ).rejects.toThrow(/ledger_chain_guard/);
  });

  test('ledger one entry per (wallet, transaction) and per (wallet, version)', async () => {
    const wallet = await openWallet('100.00');
    const winA = await insertTx(db.sql, txRow(wallet, { kind: 'WIN' }));
    const winB = await insertTx(db.sql, txRow(wallet, { kind: 'WIN' }));
    await db.sql.begin((tx) => move(tx, wallet, winA.id, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00', version: 2 }));

    await expect(
      insertEntry(db.sql, entryRow(wallet.id, winA.id, { direction: 'CREDIT', amount: '10.00', before: '110.00', after: '120.00', version: 3 })),
    ).rejects.toThrow(/wallet_ledger_entries_wallet_id_transaction_id_key/);
    await expect(
      insertEntry(db.sql, entryRow(wallet.id, winB.id, { direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00', version: 2 })),
    ).rejects.toThrow(/wallet_ledger_entries_wallet_id_wallet_version_key/);
  });
});

describe('wager_transactions', () => {
  test('transaction idempotency_key and (provider, external id) are unique', async () => {
    const wallet = await openWallet();
    const first = await insertTx(db.sql, txRow(wallet));
    await expect(insertTx(db.sql, txRow(wallet, { idempotency_key: first.idempotency_key }))).rejects.toThrow(
      /wager_transactions_idempotency_key_key/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { external_transaction_id: first.external_transaction_id }))).rejects.toThrow(
      /wager_transactions_provider_id_external_transaction_id_key/,
    );
    // The external id is only unique per provider.
    await insertTx(db.sql, txRow(wallet, { provider_id: 'provider-b', external_transaction_id: first.external_transaction_id }));
  });

  test('kind, status, failure_code, amount and payload_hash are constrained', async () => {
    const wallet = await openWallet();
    await expect(insertTx(db.sql, txRow(wallet, { kind: 'BONUS' }))).rejects.toThrow(/wager_transactions_kind_check/);
    await expect(insertTx(db.sql, txRow(wallet, { status: 'DONE' }))).rejects.toThrow(/wager_transactions_status_check/);
    await expect(insertTx(db.sql, txRow(wallet, { status: 'FAILED', failure_code: 'OOPS' }))).rejects.toThrow(
      /wager_transactions_failure_code_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { amount: '0.00' }))).rejects.toThrow(/wager_transactions_amount_check/);
    await expect(insertTx(db.sql, txRow(wallet, { currency: 'R$1' }))).rejects.toThrow(/wager_transactions_currency_check/);
    await expect(insertTx(db.sql, txRow(wallet, { payload_hash: 'Z'.repeat(64) }))).rejects.toThrow(
      /wager_transactions_payload_hash_check/,
    );
  });

  test('only OPENING may omit round and game', async () => {
    const wallet = await openWallet();
    await expect(insertTx(db.sql, txRow(wallet, { round_id: null }))).rejects.toThrow(/wager_transactions_round_game_check/);
    await expect(insertTx(db.sql, txRow(wallet, { game_id: null }))).rejects.toThrow(/wager_transactions_round_game_check/);
  });

  test('REFUND/ROLLBACK require reference_external_transaction_id', async () => {
    const wallet = await openWallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expect(insertTx(db.sql, txRow(wallet, { kind }))).rejects.toThrow(/wager_transactions_reference_required_check/);
    }
    await insertTx(db.sql, txRow(wallet, { kind: 'REFUND', reference_external_transaction_id: 'ext-bet' }));
  });

  test('REJECTED requires failure_code; PROCESSED requires processed_at', async () => {
    const wallet = await openWallet();
    await expect(insertTx(db.sql, txRow(wallet, { status: 'REJECTED', observed_balance: '0.00' }))).rejects.toThrow(
      /wager_transactions_failure_code_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { status: 'FAILED' }))).rejects.toThrow(
      /wager_transactions_failure_code_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { failure_code: 'INSUFFICIENT_FUNDS' }))).rejects.toThrow(
      /wager_transactions_failure_code_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { status: 'PROCESSED', observed_balance: '0.00' }))).rejects.toThrow(
      /wager_transactions_processed_at_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { processed_at: T0 }))).rejects.toThrow(
      /wager_transactions_processed_at_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, { status: 'PENDING_REFERENCE' }))).rejects.toThrow(
      /wager_transactions_next_attempt_at_status_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, processed({ observed_balance: null })))).rejects.toThrow(
      /wager_transactions_observed_balance_check/,
    );
    await expect(insertTx(db.sql, txRow(wallet, processed({ observed_balance: '-1.00' })))).rejects.toThrow(
      /wager_transactions_observed_balance_check/,
    );

    await insertTx(db.sql, txRow(wallet, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', observed_balance: '0.00' }));
    await insertTx(db.sql, txRow(wallet, { status: 'FAILED', failure_code: 'INTERNAL_PROCESSING_ERROR' }));
    await insertTx(db.sql, txRow(wallet, { status: 'PENDING_REFERENCE', next_attempt_at: T0 }));
  });

  test('a transaction can be reversed only once (any reversal kind)', async () => {
    const wallet = await openWallet();
    const bet = await insertTx(db.sql, txRow(wallet, processed()));
    const reversal = (kind: string, overrides: Row = {}) =>
      txRow(wallet, { kind, reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id, ...overrides });

    await insertTx(db.sql, reversal('REFUND', processed()));
    await expect(insertTx(db.sql, reversal('ROLLBACK', processed()))).rejects.toThrow(/wager_transactions_single_reversal_key/);
    await expect(insertTx(db.sql, reversal('REFUND', processed()))).rejects.toThrow(/wager_transactions_single_reversal_key/);

    // Non-processed reversals of the same reference may exist, but cannot become PROCESSED.
    const pending = await insertTx(db.sql, reversal('ROLLBACK'));
    await expect(
      db.sql`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = ${T0}, observed_balance = 0 WHERE id = ${pending.id}`,
    ).rejects.toThrow(/wager_transactions_single_reversal_key/);

    // A BET may still have several WINs.
    await insertTx(db.sql, reversal('WIN', processed()));
    await insertTx(db.sql, reversal('WIN', processed()));
  });

  test('terminal transaction cannot change; business fields never change', async () => {
    const wallet = await openWallet();
    const tx = await insertTx(db.sql, txRow(wallet));
    const businessUpdates = [
      () => db.sql`UPDATE wager_transactions SET amount = 11 WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET kind = 'WIN' WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET payload_hash = ${'b'.repeat(64)} WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET idempotency_key = 'other' WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET round_id = 'round-2' WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET reference_external_transaction_id = 'x' WHERE id = ${tx.id}`,
      () => db.sql`UPDATE wager_transactions SET created_at = now() WHERE id = ${tx.id}`,
    ];
    for (const update of businessUpdates) {
      await expect(update()).rejects.toThrow(/wager_transactions_guard/);
    }

    // Lifecycle columns may change while the transaction is not terminal.
    await db.sql`UPDATE wager_transactions SET status = 'PENDING_REFERENCE', next_attempt_at = ${T0}, attempts = 1 WHERE id = ${tx.id}`;
    await db.sql`UPDATE wager_transactions SET status = 'PROCESSED', next_attempt_at = NULL, processed_at = ${T0}, observed_balance = 0 WHERE id = ${tx.id}`;

    await expect(db.sql`UPDATE wager_transactions SET updated_at = now() WHERE id = ${tx.id}`).rejects.toThrow(
      /wager_transactions_guard/,
    );
    await expect(
      db.sql`UPDATE wager_transactions SET status = 'FAILED', failure_code = 'INTERNAL_PROCESSING_ERROR', processed_at = NULL, observed_balance = NULL WHERE id = ${tx.id}`,
    ).rejects.toThrow(/wager_transactions_guard/);

    const rejected = await insertTx(db.sql, txRow(wallet, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', observed_balance: '0.00' }));
    await expect(db.sql`UPDATE wager_transactions SET attempts = 1 WHERE id = ${rejected.id}`).rejects.toThrow(
      /wager_transactions_guard/,
    );
  });
});

describe('outbox_messages', () => {
  async function insertOutbox(overrides: Row = {}): Promise<string> {
    const row = {
      id: uuid(),
      aggregate_id: uuid(),
      event_type: 'WagerTransactionProcessed',
      payload: { eventId: 'e1' },
      occurred_at: T0,
      attempts: 0,
      next_attempt_at: T0,
      ...overrides,
    };
    await db.sql`INSERT INTO outbox_messages ${db.sql(row)}`;
    return row.id;
  }

  test('outbox payload cannot change and cannot be unpublished', async () => {
    const id = await insertOutbox();
    await expect(db.sql`UPDATE outbox_messages SET payload = '{"eventId":"e2"}' WHERE id = ${id}`).rejects.toThrow(
      /outbox_guard/,
    );
    await expect(db.sql`UPDATE outbox_messages SET event_type = 'Other' WHERE id = ${id}`).rejects.toThrow(/outbox_guard/);
    await expect(db.sql`UPDATE outbox_messages SET aggregate_id = ${uuid()} WHERE id = ${id}`).rejects.toThrow(/outbox_guard/);
    await expect(db.sql`UPDATE outbox_messages SET occurred_at = now() WHERE id = ${id}`).rejects.toThrow(/outbox_guard/);

    await db.sql`UPDATE outbox_messages SET attempts = 1, next_attempt_at = now() WHERE id = ${id}`;
    await db.sql`UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE id = ${id}`;

    await expect(db.sql`UPDATE outbox_messages SET published_at = NULL, next_attempt_at = now() WHERE id = ${id}`).rejects.toThrow(
      /outbox_guard/,
    );
    await expect(db.sql`UPDATE outbox_messages SET published_at = now() + interval '1 second' WHERE id = ${id}`).rejects.toThrow(
      /outbox_guard/,
    );
  });

  test('pending outbox message must be scheduled', async () => {
    await expect(insertOutbox({ next_attempt_at: null })).rejects.toThrow(/outbox_messages_next_attempt_at_check/);
  });
});

describe('inbox_messages', () => {
  test('one inbox row per (consumer, message)', async () => {
    const row = { consumer_name: 'c1', message_id: uuid(), payload_hash: 'a'.repeat(64), received_at: T0, processed_at: T0 };
    await db.sql`INSERT INTO inbox_messages ${db.sql(row)}`;
    await expect(db.sql`INSERT INTO inbox_messages ${db.sql(row)}`).rejects.toThrow(/inbox_messages_pkey/);
    await db.sql`INSERT INTO inbox_messages ${db.sql({ ...row, consumer_name: 'c2' })}`;
  });
});

test('happy path insert (wallet + opening tx + entry) commits', async () => {
  const wallet = await openWallet('100.00');
  expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });

  // Several balance moves in one SQL transaction: the deferred check sees the final state.
  const bet = await insertTx(db.sql, txRow(wallet, { amount: '30.00' }));
  const win = await insertTx(db.sql, txRow(wallet, { kind: 'WIN', amount: '5.00' }));
  await db.sql.begin(async (tx) => {
    await move(tx, wallet, bet.id, { direction: 'DEBIT', amount: '30.00', before: '100.00', after: '70.00', version: 2 });
    await move(tx, wallet, win.id, { direction: 'CREDIT', amount: '5.00', before: '70.00', after: '75.00', version: 3 });
    await tx`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = ${T0}, observed_balance = 70 WHERE id = ${bet.id}`;
    await tx`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = ${T0}, observed_balance = 75 WHERE id = ${win.id}`;
  });
  expect(await walletState(wallet.id)).toEqual({ balance: '75.00', version: 3 });

  // A wallet opened with zero starts its chain at version 2.
  const empty = await openWallet();
  const credit = await insertTx(db.sql, txRow(empty, { kind: 'WIN' }));
  await db.sql.begin((tx) => move(tx, empty, credit.id, { direction: 'CREDIT', amount: '10.00', before: '0.00', after: '10.00', version: 2 }));
  expect(await walletState(empty.id)).toEqual({ balance: '10.00', version: 2 });
});
