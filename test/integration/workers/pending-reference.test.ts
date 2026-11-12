import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { WagerCommand } from '../../../src/application/commands/wager-command';
import type { Clock } from '../../../src/application/ports/clock';
import type { FaultInjector } from '../../../src/application/ports/fault-injector';
import { noopMetrics } from '../../../src/application/ports/metrics';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import {
  RetryPendingReferences,
  type PendingReferencePolicy,
} from '../../../src/application/use-cases/retry-pending-references';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { PENDING_REFERENCE_BACKOFF } from '../../../src/domain/messaging/backoff';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction.types';
import { loadEnv } from '../../../src/infrastructure/config/env';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../../src/infrastructure/runtime/system-clock';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createSqsClient } from '../../../src/infrastructure/sqs/sqs-client';
import { OutboxPublisherWorker } from '../../../src/interfaces/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference.worker';
import { bootstrapWorkers } from '../../../src/main.workers';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { eventually } from '../../support/eventually';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId, testOrm } from '../../support/persistence';
import { createTestQueues } from '../../support/sqs';
import { fixedClock, recordingMetrics, wagerCommand, type WalletRef } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let metrics: ReturnType<typeof recordingMetrics>;
const clock = fixedClock();
const T0 = clock.now();
const ids = new UuidV7IdGenerator();
const noFaults: FaultInjector = { hit: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
const policy: PendingReferencePolicy = {
  maxAttempts: 10,
  ttlMs: 900_000,
  backoff: { ...PENDING_REFERENCE_BACKOFF, jitter: () => 0 },
};
const SLOW = { timeout: 60_000 };

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
});

beforeEach(() => {
  metrics = recordingMetrics();
  clock.set(T0);
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  await assertLedgerConsistency(db.sql);
});

afterAll(async () => {
  await orm?.close(true);
  await db.drop();
});

const at = (ms: number) => new Date(T0.getTime() + ms);

function retryUseCase(over: { unitOfWork?: UnitOfWork; policy?: Partial<PendingReferencePolicy> } = {}): RetryPendingReferences {
  return new RetryPendingReferences(over.unitOfWork ?? uow, clock, ids, noFaults, metrics, { ...policy, ...over.policy });
}

function submit(cmd: WagerCommand, over: { unitOfWork?: UnitOfWork; clock?: Clock } = {}) {
  return new SubmitWagerTransaction(over.unitOfWork ?? uow, over.clock ?? clock, ids, noFaults, noopMetrics, () => 0).execute(
    cmd,
    { type: 'http' },
    'corr-submit',
  );
}

function openWallet(amount = '100.00', at: Clock = clock): Promise<WalletRef> {
  return new OpenWallet(uow, at, ids, noopMetrics).execute({
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'open',
  });
}

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function txRow(id: string) {
  const [row] = await db.sql`
    SELECT status, failure_code, attempts, next_attempt_at, reference_transaction_id,
           observed_balance::text AS observed_balance
      FROM wager_transactions WHERE id = ${id}`;
  return row;
}

async function balance(walletId: string): Promise<string> {
  const [row] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return row.balance;
}

async function eventsCausedBy(transactionId: string) {
  return db.sql`
    SELECT event_type, payload->>'correlationId' AS correlation_id, payload->'data'->>'failureCode' AS failure_code
      FROM outbox_messages WHERE payload->>'causationId' = ${transactionId} ORDER BY event_type`;
}

/** Holds every caller of `wait()` until `parties` callers arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === parties) open();
    return opened;
  };
}

/** A UnitOfWork whose first `run` (the candidate read) waits for the barrier before returning. */
function afterFirstRun(inner: UnitOfWork, wait: () => Promise<void>): UnitOfWork {
  let first = true;
  return {
    run: async (fn, opts) => {
      const result = await inner.run(fn, opts);
      if (first) {
        first = false;
        await wait();
      }
      return result;
    },
  };
}

describe('RetryPendingReferences', () => {
  test('ROLLBACK pending, BET arrives → worker resolves ROLLBACK, balance back, events emitted', async () => {
    const wallet = await openWallet();
    const betExternalId = `ext-${newId()}`;
    const rollback = await submit(
      wagerCommand(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: betExternalId, money: money('10.00') }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    const bet = await submit(wagerCommand(wallet, { externalTransactionId: betExternalId, money: money('10.00') }));
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(await balance(wallet.id)).toBe('90.00');

    expect(await retryUseCase().execute(20)).toEqual({ resolved: 1, rescheduled: 0, expired: 0 });

    expect(await txRow(rollback.transactionId)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      next_attempt_at: null,
      reference_transaction_id: bet.transactionId,
      observed_balance: '100.00',
    });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await eventsCausedBy(rollback.transactionId)).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'corr-submit', failure_code: null },
      { event_type: 'WagerTransactionProcessed', correlation_id: rollback.transactionId, failure_code: null },
      { event_type: 'WalletBalanceChanged', correlation_id: rollback.transactionId, failure_code: null },
    ]);
    expect(metrics.named('transaction')).toEqual([['PROCESSED', 'ROLLBACK', 'worker']]);
    expect(metrics.named('setPendingReferences')).toEqual([[0]]);
  });

  test('REFUND pending with no reference → rescheduled with backoff; after maxAttempts → REJECTED REFERENCE_NOT_FOUND + Rejected event', async () => {
    const wallet = await openWallet();
    const refund = await submit(
      wagerCommand(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: `ext-${newId()}` }),
    );
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0, next_attempt_at: at(2000) });
    const retry = retryUseCase({ policy: { maxAttempts: 3 } });

    // Not due before its next attempt.
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 0, expired: 0 });

    clock.set(at(2000));
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 1, expired: 0 });
    // attempt 1: 2s · 2^1.
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1, next_attempt_at: at(6000) });

    clock.set(at(6000));
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 1, expired: 0 });
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2, next_attempt_at: at(14_000) });
    expect(metrics.named('setPendingReferences')).toEqual([[1], [1], [1]]);

    clock.set(at(14_000));
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 0, expired: 1 });
    expect(await txRow(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      attempts: 3,
      next_attempt_at: null,
      observed_balance: '100.00',
    });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await eventsCausedBy(refund.transactionId)).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'corr-submit', failure_code: null },
      { event_type: 'WagerTransactionRejected', correlation_id: refund.transactionId, failure_code: 'REFERENCE_NOT_FOUND' },
    ]);
    expect(metrics.named('retry')).toEqual([['pending-reference'], ['pending-reference']]);
    expect(metrics.named('transaction')).toEqual([['REJECTED', 'REFUND', 'worker']]);
    expect(metrics.named('setPendingReferences').at(-1)).toEqual([0]);
  });

  test('TTL exceeded (clock advanced) → REJECTED REFERENCE_NOT_FOUND even with attempts left', async () => {
    const wallet = await openWallet();
    const refund = await submit(
      wagerCommand(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: `ext-${newId()}` }),
    );
    const retry = retryUseCase({ policy: { maxAttempts: 10, ttlMs: 60_000 } });

    clock.set(at(59_999));
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 1, expired: 0 });
    // Due again at 59.999s + 4s: past the 60s TTL with 8 attempts left.
    clock.set(at(64_000));
    expect(await retry.execute(20)).toEqual({ resolved: 0, rescheduled: 0, expired: 1 });
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', attempts: 2 });
  });

  test('a reference that arrived resolves even when attempts and TTL are exhausted', async () => {
    const wallet = await openWallet();
    const betExternalId = `ext-${newId()}`;
    const win = await submit(
      wagerCommand(wallet, { kind: WagerTransactionKind.Win, referenceExternalTransactionId: betExternalId, money: money('5.00') }),
    );
    clock.set(at(3_600_000));
    await submit(wagerCommand(wallet, { externalTransactionId: betExternalId }));

    expect(await retryUseCase({ policy: { maxAttempts: 1, ttlMs: 1000 } }).execute(20)).toEqual({
      resolved: 1,
      rescheduled: 0,
      expired: 0,
    });
    expect(await txRow(win.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await balance(wallet.id)).toBe('95.00');
  });

  test(
    'two workers on the same candidates resolve each exactly once',
    async () => {
      // 5 wallets × 4 WINs waiting for the same BET.
      const wins: string[] = [];
      for (let w = 0; w < 5; w++) {
        const wallet = await openWallet();
        const betExternalId = `ext-${newId()}`;
        for (let i = 0; i < 4; i++) {
          const win = await submit(
            wagerCommand(wallet, { kind: WagerTransactionKind.Win, referenceExternalTransactionId: betExternalId, money: money('1.00') }),
          );
          wins.push(win.transactionId);
        }
        await submit(wagerCommand(wallet, { externalTransactionId: betExternalId }));
      }
      const [ormA, ormB] = await Promise.all([testOrm(db.url), testOrm(db.url)]);
      cleanups.push(() => Promise.all([ormA.close(true), ormB.close(true)]));
      const bothReadCandidates = barrier(2);
      const a = retryUseCase({ unitOfWork: afterFirstRun(new MikroOrmUnitOfWork(ormA, noopMetrics), bothReadCandidates) });
      const b = retryUseCase({ unitOfWork: afterFirstRun(new MikroOrmUnitOfWork(ormB, noopMetrics), bothReadCandidates) });

      const [byA, byB] = await Promise.all([a.execute(20), b.execute(20)]);

      expect(byA.resolved + byB.resolved).toBe(20);
      expect(byA.rescheduled + byB.rescheduled + byA.expired + byB.expired).toBe(0);
      const statuses = await db.sql`SELECT DISTINCT status FROM wager_transactions WHERE id IN ${db.sql(wins)}`;
      expect(statuses).toEqual([{ status: 'PROCESSED' }]);
      const perTx = await db.sql`
        SELECT payload->>'causationId' AS tx, count(*)::int AS n FROM outbox_messages
         WHERE event_type = 'WagerTransactionProcessed' AND payload->>'causationId' IN ${db.sql(wins)}
         GROUP BY 1`;
      expect(perTx).toHaveLength(20);
      expect(perTx.every((r: { n: number }) => r.n === 1)).toBe(true);
      const [{ entries }] = await db.sql`
        SELECT count(*)::int AS entries FROM wallet_ledger_entries WHERE transaction_id IN ${db.sql(wins)}`;
      expect(entries).toBe(20);
    },
    SLOW,
  );

  test(
    'worker and submit on the same wallet do not deadlock (100 iterations interleaved)',
    async () => {
      const wallet = await openWallet('1000.00');
      const workerOrm = await testOrm(db.url);
      cleanups.push(() => workerOrm.close(true));
      const retry = retryUseCase({ unitOfWork: new MikroOrmUnitOfWork(workerOrm, noopMetrics) });

      const wins: string[] = [];
      let elapsed = 0;
      for (let i = 0; i < 100; i++) {
        const betExternalId = `ext-${newId()}`;
        const win = await submit(
          wagerCommand(wallet, { kind: WagerTransactionKind.Win, referenceExternalTransactionId: betExternalId, money: money('1.00') }),
        );
        wins.push(win.transactionId);
        // The WIN is due: the worker locks it while its BET (which nudges it) and another BET lock the wallet.
        elapsed += 2000;
        clock.set(at(elapsed));
        await Promise.all([
          retry.execute(20),
          submit(wagerCommand(wallet, { externalTransactionId: betExternalId, money: money('1.00') })),
          submit(wagerCommand(wallet, { money: money('1.00') })),
        ]);
      }
      // A WIN the worker saw before its BET was rescheduled, then nudged by the BET: due now.
      await retry.execute(100);

      const statuses = await db.sql`SELECT DISTINCT status FROM wager_transactions WHERE id IN ${db.sql(wins)}`;
      expect(statuses).toEqual([{ status: 'PROCESSED' }]);
      expect(await balance(wallet.id)).toBe('900.00');
    },
    SLOW,
  );
});

describe('workers process', () => {
  test('bootstrapWorkers publishes the outbox and resolves pending references', async () => {
    const sqs: SQSClient = createSqsClient(loadEnv({ DATABASE_URL: db.url }));
    const q = await createTestQueues(sqs, 'workers');
    cleanups.push(async () => {
      await q.destroy();
      sqs.destroy();
    });
    const app = await bootstrapWorkers(
      loadEnv({
        DATABASE_URL: db.url,
        DB_POOL_MAX: '5',
        JITTER: 'off',
        LOG_LEVEL: 'silent',
        EVENTS_QUEUE_URL: q.eventsUrl,
        OUTBOX_POLL_MS: '50',
        PENDING_REF_POLL_MS: '50',
      }),
    );
    cleanups.push(() => app.close());
    app.get(OutboxPublisherWorker).start();
    app.get(PendingReferenceWorker).start();

    // Real time: the workers run on the system clock.
    const realClock = new SystemClock();
    const wallet = await openWallet('100.00', realClock);
    const betExternalId = `ext-${newId()}`;
    const rollback = await submit(
      wagerCommand(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: betExternalId }),
      { clock: realClock },
    );
    await submit(wagerCommand(wallet, { externalTransactionId: betExternalId }), { clock: realClock });

    await eventually(async () => expect(await txRow(rollback.transactionId)).toMatchObject({ status: 'PROCESSED' }));
    await eventually(async () => {
      const unpublished = await db.sql`
        SELECT id FROM outbox_messages WHERE published_at IS NULL AND aggregate_id = ${wallet.id}`;
      expect(unpublished).toEqual([]);
    });
    expect(await eventsCausedBy(rollback.transactionId)).toHaveLength(3);
    expect(await balance(wallet.id)).toBe('100.00');
  });
});
