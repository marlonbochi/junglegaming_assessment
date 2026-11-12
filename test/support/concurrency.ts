import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { loadEnv } from '../../src/infrastructure/config/env';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { createTestDatabase, type TestDatabase } from './db';
import { assertLedgerConsistency } from './ledger-consistency';
import { killAll } from './processes';
import { createTestQueues, type TestQueueOptions, type TestQueues } from './sqs';

export interface ConcurrencySuite {
  readonly db: TestDatabase;
  readonly sqs: SQSClient;
  readonly queues: TestQueues;
  /** Environment of a spawned service bound to this file's database and queues. */
  env(extra?: Record<string, string>): Record<string, string>;
  /** Non-OPENING transactions of a wallet, oldest first. */
  wagers(walletId: string): Promise<Array<{ id: string; kind: string; status: string; failure_code: string | null }>>;
  balance(walletId: string): Promise<string>;
  debits(walletId: string): Promise<number>;
}

/**
 * Registers the hooks of a concurrency test file: a database and queues of its own, every spawned
 * process killed after each test, and the ledger invariant checked once they are gone.
 */
export function concurrencySuite(prefix: string, queueOptions: TestQueueOptions = {}): ConcurrencySuite {
  let db: TestDatabase;
  let sqs: SQSClient;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase();
    sqs = createSqsClient(loadEnv({ DATABASE_URL: db.url }));
    queues = await createTestQueues(sqs, prefix, queueOptions);
  });

  afterEach(async () => {
    await killAll();
    await assertLedgerConsistency(db.sql);
  });

  afterAll(async () => {
    await killAll();
    await queues?.destroy();
    sqs?.destroy();
    await db?.drop();
  });

  return {
    get db() {
      return db;
    },
    get sqs() {
      return sqs;
    },
    get queues() {
      return queues;
    },
    env: (extra = {}) => ({
      DATABASE_URL: db.url,
      WAGER_QUEUE_URL: queues.queueUrl,
      WAGER_DLQ_URL: queues.dlqUrl,
      EVENTS_QUEUE_URL: queues.eventsUrl,
      DB_POOL_MAX: '10',
      JITTER: 'off',
      LOG_LEVEL: 'warn',
      OUTBOX_POLL_MS: '100',
      PENDING_REF_POLL_MS: '200',
      ...extra,
    }),
    wagers: (walletId) => db.sql`
      SELECT id, kind, status, failure_code FROM wager_transactions
       WHERE wallet_id = ${walletId} AND kind <> 'OPENING' ORDER BY created_at, id`,
    async balance(walletId) {
      const [row] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
      return row.balance;
    },
    async debits(walletId) {
      const [row] = await db.sql`
        SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
      return row.n;
    },
  };
}
