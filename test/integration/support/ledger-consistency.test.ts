import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId } from '../../support/persistence';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(() => db.drop());

interface Entry {
  version: number;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  before: string;
  after: string;
}

/**
 * Writes a wallet and its ledger with triggers and FKs disabled (session_replication_role = replica),
 * so the helper can be shown broken states the schema would never accept.
 */
async function seed(balance: string, version: number, entries: Entry[]): Promise<string> {
  const walletId = newId();
  await db.sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO wallets ${tx({
      id: walletId,
      player_id: newId(),
      currency: 'BRL',
      balance,
      version,
      created_at: new Date(),
      updated_at: new Date(),
    })}`;
    for (const e of entries) {
      await tx`INSERT INTO wallet_ledger_entries ${tx({
        id: newId(),
        wallet_id: walletId,
        transaction_id: newId(),
        direction: e.direction,
        amount: e.amount,
        currency: 'BRL',
        balance_before: e.before,
        balance_after: e.after,
        wallet_version: e.version,
        created_at: new Date(),
      })}`;
    }
  });
  return walletId;
}

const credit = (version: number, amount: string, before: string, after: string): Entry => ({
  version,
  direction: 'CREDIT',
  amount,
  before,
  after,
});
const debit = (version: number, amount: string, before: string, after: string): Entry => ({
  version,
  direction: 'DEBIT',
  amount,
  before,
  after,
});

describe('assertLedgerConsistency', () => {
  test('accepts consistent wallets: opened with balance, opened at zero, untouched', async () => {
    const ids = [
      await seed('70.00', 2, [credit(1, '100.00', '0.00', '100.00'), debit(2, '30.00', '100.00', '70.00')]),
      await seed('5.00', 2, [credit(2, '5.00', '0.00', '5.00')]),
      await seed('0.00', 1, []),
    ];
    await assertLedgerConsistency(db.sql, ids);
  });

  test.each([
    ['balance differs from ledger', () => seed('99.00', 1, [credit(1, '100.00', '0.00', '100.00')]), /ledger sum/],
    ['balance without entries', () => seed('10.00', 1, []), /last balance_after 0.00/],
    ['version without entries', () => seed('0.00', 3, []), /version 3 without ledger entries/],
    [
      'gap in the chain',
      () => seed('15.00', 3, [credit(1, '10.00', '0.00', '10.00'), credit(3, '5.00', '10.00', '15.00')]),
      /gaps/,
    ],
    ['chain starting at 3', () => seed('10.00', 3, [credit(3, '10.00', '0.00', '10.00')]), /starts at wallet_version 3/],
    ['wallet version ahead of chain', () => seed('10.00', 2, [credit(1, '10.00', '0.00', '10.00')]), /!= wallet version 2/],
  ])('rejects %s', async (_name, arrange, message) => {
    const walletId = await arrange();
    await expect(assertLedgerConsistency(db.sql, [walletId])).rejects.toThrow(message);
  });

  test('rejects a wallet id that does not exist', async () => {
    const missing = newId();
    await expect(assertLedgerConsistency(db.sql, [missing])).rejects.toThrow(`wallet ${missing}: not found`);
  });

  test('without ids it checks every wallet', async () => {
    await expect(assertLedgerConsistency(db.sql)).rejects.toThrow(/Ledger inconsistency/);
  });
});
