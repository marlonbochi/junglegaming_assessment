import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { createTestDatabase, migrateDatabase, type TestDatabase } from '../../support/db';

const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
const FUNCTIONS = [
  'ledger_append_only',
  'ledger_chain_guard',
  'outbox_guard',
  'wager_transactions_guard',
  'wallets_ledger_consistency',
  'wallets_version_guard',
];

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(() => db.drop());

async function tables(sql: SQL): Promise<string[]> {
  const rows: { table_name: string }[] = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'mikro_orm_migrations'
    ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

async function functions(sql: SQL): Promise<string[]> {
  const rows: { proname: string }[] = await sql`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY p.proname`;
  return rows.map((r) => r.proname);
}

test('up → down → up leaves the full schema and down removes all of it', async () => {
  // The template the database was cloned from has already been migrated up.
  expect(await tables(db.sql)).toEqual(TABLES);
  expect(await functions(db.sql)).toEqual(FUNCTIONS);

  await migrateDatabase(db.url, 'down');
  expect(await tables(db.sql)).toEqual([]);
  expect(await functions(db.sql)).toEqual([]);

  await migrateDatabase(db.url, 'up');
  expect(await tables(db.sql)).toEqual(TABLES);
  expect(await functions(db.sql)).toEqual(FUNCTIONS);
});
