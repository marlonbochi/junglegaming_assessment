import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { WagerCommand } from '../../../src/application/commands/wager-command';
import { ApplicationError, UniqueViolationError } from '../../../src/application/errors';
import { payloadHash } from '../../../src/application/hashing/payload-hash';
import type { FaultInjector } from '../../../src/application/ports/fault-injector';
import { noopMetrics } from '../../../src/application/ports/metrics';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import type { WagerTransactionRepository } from '../../../src/application/ports/wager-transaction.repository';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionKind, WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction.types';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { eventually } from '../../support/eventually';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { latch, newId, testOrm } from '../../support/persistence';
import { fixedClock, recordingMetrics, wagerCommand, type WalletRef } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let metrics: ReturnType<typeof recordingMetrics>;
const clock = fixedClock();
const ids = new UuidV7IdGenerator();
const noFaults: FaultInjector = { hit: () => {} };
const T0 = clock.now();

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
});

beforeEach(() => {
  metrics = recordingMetrics();
  clock.set(T0);
});

afterEach(() => assertLedgerConsistency(db.sql));

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const http = { type: 'http' } as const;
const sqs = (messageId: string = newId()) => ({ type: 'sqs', consumerName: 'wager-consumer', messageId }) as const;

function useCase(over: { unitOfWork?: UnitOfWork; faults?: FaultInjector } = {}) {
  return new SubmitWagerTransaction(over.unitOfWork ?? uow, clock, ids, over.faults ?? noFaults, metrics, () => 0);
}

const submit = (cmd: WagerCommand, source: Parameters<SubmitWagerTransaction['execute']>[1] = http) =>
  useCase().execute(cmd, source, 'corr-1');

function openWallet(amount = '100.00'): Promise<WalletRef> {
  return new OpenWallet(uow, clock, ids, noopMetrics).execute({
    playerId: newId(),
    initialBalance: brl(amount),
    correlationId: 'open',
  });
}

async function walletState(walletId: string) {
  const [row] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${walletId}`;
  return row as { balance: string; version: number };
}

async function txRow(transactionId: string) {
  const [row] = await db.sql`
    SELECT status, failure_code, observed_balance::text AS observed_balance, payload_hash, idempotency_key,
           reference_transaction_id, attempts, next_attempt_at
      FROM wager_transactions WHERE id = ${transactionId}`;
  return row;
}

async function entriesOf(transactionId: string) {
  return db.sql`
    SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
           balance_after::text AS balance_after, wallet_version
      FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
}

/** Outbox events caused by `transactionId`, in creation order. */
async function eventsOf(transactionId: string) {
  return db.sql`
    SELECT event_type, aggregate_id, payload FROM outbox_messages
     WHERE payload->>'causationId' = ${transactionId} ORDER BY id`;
}

/** Everything a submission could write for `walletId` / `idempotencyKey`. */
async function footprint(walletId: string, idempotencyKey: string) {
  const [row] = await db.sql`
    SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT count(*)::int FROM wager_transactions WHERE idempotency_key = ${idempotencyKey}) AS by_key,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS events,
           (SELECT count(*)::int FROM inbox_messages) AS inbox,
           (SELECT balance::text FROM wallets WHERE id = ${walletId}) AS balance`;
  return row;
}

async function inboxRows(messageId: string) {
  return db.sql`SELECT consumer_name, payload_hash FROM inbox_messages WHERE message_id = ${messageId}`;
}

/** Waits until `n` backends of this test database are blocked on a lock. */
function waitForLockWaiters(n: number): Promise<void> {
  return eventually(async () => {
    const [row] = await db.sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(row.waiting).toBe(n);
  });
}

/** A unit of work whose first run pauses right after `transactions.insert` until `release()`. */
function pausingAfterInsert() {
  const inserted = latch();
  const gate = latch();
  let first = true;
  const hold = (transactions: WagerTransactionRepository): WagerTransactionRepository =>
    new Proxy(transactions, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== 'insert') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<WagerTransactionRepository['insert']>) => {
          await target.insert(...args);
          inserted.release();
          await gate.promise;
        };
      },
    });
  const unitOfWork: UnitOfWork = {
    run: (fn) => {
      const paused = first;
      first = false;
      return uow.run((r) => fn(paused ? { ...r, transactions: hold(r.transactions) } : r));
    },
  };
  return { unitOfWork, inserted: inserted.promise, release: gate.release };
}

describe('SubmitWagerTransaction', () => {
  test('BET processed: balance, entry, outbox has Processed + WalletBalanceChanged', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, { money: brl('30.00') });

    const result = await submit(cmd);

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: Status.Processed,
      balance: brl('70.00'),
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual({ balance: '70.00', version: 2 });
    expect(await txRow(result.transactionId)).toMatchObject({
      status: Status.Processed,
      failure_code: null,
      observed_balance: '70.00',
      payload_hash: payloadHash(cmd),
      idempotency_key: cmd.idempotencyKey,
    });
    expect(await entriesOf(result.transactionId)).toEqual([
      { direction: 'DEBIT', amount: '30.00', balance_before: '100.00', balance_after: '70.00', wallet_version: 2 },
    ]);

    const events = await eventsOf(result.transactionId);
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const e of events) {
      expect(e.aggregate_id).toBe(wallet.id);
      expect(e.payload).toMatchObject({
        correlationId: 'corr-1',
        causationId: result.transactionId,
        occurredAt: T0.toISOString(),
      });
    }
    expect(events[0].payload.data).toMatchObject({ transactionId: result.transactionId, balance: brl('70.00') });
    expect(events[1].payload.data).toMatchObject({ walletVersion: 2, balanceAfter: brl('70.00') });

    expect(metrics.named('transaction')).toEqual([['PROCESSED', 'BET', 'http']]);
    expect(metrics.named('processingDuration')).toEqual([['http', expect.any(Number)]]);
    expect(metrics.named('duplicate')).toEqual([]);
  });

  test('LOSS processed: no entry, outbox has only WagerTransactionProcessed', async () => {
    const wallet = await openWallet('100.00');
    const result = await submit(wagerCommand(wallet, { kind: WagerTransactionKind.Loss }));

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: Status.Processed,
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await entriesOf(result.transactionId)).toEqual([]);
    expect((await eventsOf(result.transactionId)).map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('BET rejected INSUFFICIENT_FUNDS persisted with observed_balance; outbox has Rejected only', async () => {
    const wallet = await openWallet('100.00');
    const result = await submit(wagerCommand(wallet, { money: brl('150.00') }));

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(await txRow(result.transactionId)).toMatchObject({
      status: Status.Rejected,
      failure_code: 'INSUFFICIENT_FUNDS',
      observed_balance: '100.00',
    });
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await entriesOf(result.transactionId)).toEqual([]);
    const events = await eventsOf(result.transactionId);
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['WagerTransactionRejected']);
    expect(events[0].payload.data).toMatchObject({ failureCode: FailureCode.InsufficientFunds, balance: brl('100.00') });
    expect(metrics.named('transaction')).toEqual([['REJECTED', 'BET', 'http']]);
  });

  test('replay returns original result with idempotentReplay true, including balance observed then', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: brl('80.00') });

    const first = await submit(bet);
    await submit(wagerCommand(wallet, { kind: WagerTransactionKind.Win, money: brl('5.00') }));
    const before = await footprint(wallet.id, bet.idempotencyKey);
    const again = await submit(bet);

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(again.balance).toEqual(brl('20.00'));
    expect(await walletState(wallet.id)).toEqual({ balance: '25.00', version: 3 });
    expect(await footprint(wallet.id, bet.idempotencyKey)).toEqual(before);
    expect(metrics.named('duplicate')).toEqual([['http', 'replay']]);
    expect(metrics.named('transaction')).toEqual([
      ['PROCESSED', 'BET', 'http'],
      ['PROCESSED', 'WIN', 'http'],
    ]);
  });

  test('replay of a rejected transaction returns the original rejection', async () => {
    const wallet = await openWallet('10.00');
    const bet = wagerCommand(wallet, { money: brl('50.00') });
    const first = await submit(bet);
    await submit(wagerCommand(wallet, { kind: WagerTransactionKind.Win, money: brl('100.00') }));

    expect(await submit(bet)).toEqual({ ...first, idempotentReplay: true });
    expect(first).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: brl('10.00') });
  });

  test('same key different payload → IDEMPOTENCY_KEY_REUSED, nothing written', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, { money: brl('10.00') });
    await submit(cmd);
    const before = await footprint(wallet.id, cmd.idempotencyKey);

    const reused = submit({ ...cmd, money: brl('20.00') });
    await expect(reused).rejects.toBeInstanceOf(ApplicationError);
    await expect(reused).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await footprint(wallet.id, cmd.idempotencyKey)).toEqual(before);
  });

  test('Review Focus #5: k1 then k2 for same provider+externalId → EXTERNAL_ID_CONFLICT; arbitrary key accepted first time', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, { idempotencyKey: 'any opaque key: 42/ü' });

    expect(await submit(cmd)).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    const before = await footprint(wallet.id, cmd.idempotencyKey);

    await expect(submit({ ...cmd, idempotencyKey: 'k2' })).rejects.toMatchObject({ code: 'EXTERNAL_ID_CONFLICT' });
    await expect(submit({ ...cmd, idempotencyKey: 'k3', money: brl('1.00') })).rejects.toMatchObject({
      code: 'EXTERNAL_ID_CONFLICT',
    });
    expect(await footprint(wallet.id, cmd.idempotencyKey)).toEqual(before);
  });

  test('wallet not found → WALLET_NOT_FOUND, nothing written', async () => {
    const cmd = wagerCommand({ id: newId(), playerId: newId() });
    const before = await footprint(cmd.walletId, cmd.idempotencyKey);

    await expect(submit(cmd, sqs())).rejects.toMatchObject({ name: 'ApplicationError', code: 'WALLET_NOT_FOUND' });
    expect(await footprint(cmd.walletId, cmd.idempotencyKey)).toEqual(before);
    expect(metrics.named('transaction')).toEqual([]);
  });

  test('ROLLBACK before BET → PENDING_REFERENCE + PendingReference event; BET arrival nudges it (next_attempt_at <= now)', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: brl('30.00') });
    const rollback = wagerCommand(wallet, {
      kind: WagerTransactionKind.Rollback,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const pending = await submit(rollback);

    expect(pending).toEqual({
      transactionId: expect.any(String),
      status: Status.PendingReference,
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    const row = await txRow(pending.transactionId);
    expect(row).toMatchObject({ status: Status.PendingReference, observed_balance: null, attempts: 0 });
    expect(row.next_attempt_at).toEqual(new Date(T0.getTime() + 2000));
    const events = await eventsOf(pending.transactionId);
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(events[0].payload.data).toMatchObject({
      referenceExternalTransactionId: bet.externalTransactionId,
      nextAttemptAt: new Date(T0.getTime() + 2000).toISOString(),
    });
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });

    const later = new Date(T0.getTime() + 1000);
    clock.set(later);
    expect(await submit(bet)).toMatchObject({ status: Status.Processed, balance: brl('70.00') });

    const nudged = await txRow(pending.transactionId);
    expect(nudged.status).toBe('PENDING_REFERENCE');
    expect(nudged.next_attempt_at.getTime()).toBeLessThanOrEqual(later.getTime());

    // A pending replay reports the wallet balance now, since no decision was observed yet.
    expect(await submit(rollback)).toEqual({ ...pending, balance: brl('70.00'), idempotentReplay: true });
    expect(metrics.named('transaction')).toEqual([
      ['PENDING_REFERENCE', 'ROLLBACK', 'http'],
      ['PROCESSED', 'BET', 'http'],
    ]);
  });

  test('REFUND of a processed BET credits it back and links the reference', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerCommand(wallet, { money: brl('30.00') });
    const placed = await submit(bet);
    const refund = await submit(
      wagerCommand(wallet, {
        kind: WagerTransactionKind.Refund,
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund).toMatchObject({ status: Status.Processed, balance: brl('100.00') });
    expect((await txRow(refund.transactionId)).reference_transaction_id).toBe(placed.transactionId);
    expect(await entriesOf(refund.transactionId)).toEqual([
      { direction: 'CREDIT', amount: '30.00', balance_before: '70.00', balance_after: '100.00', wallet_version: 3 },
    ]);

    const second = await submit(
      wagerCommand(wallet, {
        kind: WagerTransactionKind.Rollback,
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(second).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
  });

  test('SQS source writes inbox; same messageId again → replay and duplicate metric; different hash → INBOX_PAYLOAD_MISMATCH', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    const message = sqs();

    const first = await submit(cmd, message);
    expect(first).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(await inboxRows(message.messageId)).toEqual([
      { consumer_name: 'wager-consumer', payload_hash: payloadHash(cmd) },
    ]);
    expect(metrics.named('transaction')).toEqual([['PROCESSED', 'BET', 'sqs']]);

    expect(await submit(cmd, message)).toEqual({ ...first, idempotentReplay: true });
    expect(await inboxRows(message.messageId)).toHaveLength(1);
    expect(metrics.named('duplicate')).toEqual([
      ['sqs', 'inbox'],
      ['sqs', 'replay'],
    ]);

    const before = await footprint(wallet.id, cmd.idempotencyKey);
    const other = wagerCommand(wallet, { money: brl('1.00') });
    await expect(submit(other, message)).rejects.toMatchObject({ code: 'INBOX_PAYLOAD_MISMATCH' });
    expect(await footprint(wallet.id, cmd.idempotencyKey)).toEqual(before);
    expect(metrics.named('transaction')).toEqual([['PROCESSED', 'BET', 'sqs']]);
  });

  test('SQS message for a tx first submitted via HTTP → replay and inbox written', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    const first = await submit(cmd, http);
    const message = sqs();

    expect(await submit(cmd, message)).toEqual({ ...first, idempotentReplay: true });
    expect(await inboxRows(message.messageId)).toEqual([
      { consumer_name: 'wager-consumer', payload_hash: payloadHash(cmd) },
    ]);
    expect(metrics.named('duplicate')).toEqual([['sqs', 'replay']]);
  });

  test.each<[string, Partial<WagerCommand>]>([
    ['0.00 amount', { money: brl('0.00') }],
    ['one decimal', { money: brl('1.5') }],
    ['negative amount', { money: brl('-1.00') }],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }],
    ['OPENING kind', { kind: WagerTransactionKind.Opening as unknown as WagerCommand['kind'] }],
    ['REFUND without reference', { kind: WagerTransactionKind.Refund }],
    ['ROLLBACK without reference', { kind: WagerTransactionKind.Rollback }],
    ['BET with reference', { referenceExternalTransactionId: 'ext-x' }],
  ])('%s → INVALID_PAYLOAD, nothing written', async (_name, overrides) => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, overrides);
    const before = await footprint(wallet.id, cmd.idempotencyKey);

    await expect(submit(cmd, sqs())).rejects.toMatchObject({ name: 'ApplicationError', code: 'INVALID_PAYLOAD' });
    expect(await footprint(wallet.id, cmd.idempotencyKey)).toEqual(before);
  });

  describe('same key with different walletId (unique race path) → resolves as IDEMPOTENCY_KEY_REUSED', () => {
    test('concurrent: the loser hits the unique index, re-runs once and sees the winner', async () => {
      const [walletA, walletB] = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
      const key = `shared-${newId()}`;
      const a = wagerCommand(walletA, { idempotencyKey: key });
      const b = wagerCommand(walletB, { idempotencyKey: key });
      const paused = pausingAfterInsert();

      const [resultA, resultB] = await Promise.allSettled([
        useCase({ unitOfWork: paused.unitOfWork }).execute(a, http, 'corr-a'),
        paused.inserted.then(async () => {
          const submitted = useCase().execute(b, http, 'corr-b');
          await waitForLockWaiters(1);
          paused.release();
          return submitted;
        }),
      ]);

      expect(resultA).toMatchObject({ status: 'fulfilled', value: { status: Status.Processed, idempotentReplay: false } });
      expect(resultB).toMatchObject({ status: 'rejected', reason: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      expect(metrics.named('lockConflict')).toHaveLength(1);
      expect(await walletState(walletA.id)).toEqual({ balance: '90.00', version: 2 });
      expect(await walletState(walletB.id)).toEqual({ balance: '100.00', version: 1 });
      expect((await footprint(walletB.id, key)).transactions).toBe(1); // only the opening
    });

    test('sequential: the second submission is a conflict, not a replay', async () => {
      const [walletA, walletB] = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
      const key = `shared-${newId()}`;

      expect(await submit(wagerCommand(walletA, { idempotencyKey: key }))).toMatchObject({ status: Status.Processed });
      await expect(submit(wagerCommand(walletB, { idempotencyKey: key }))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await walletState(walletB.id)).toEqual({ balance: '100.00', version: 1 });
    });
  });

  test('a second UniqueViolationError propagates after exactly one re-run', async () => {
    const wallet = await openWallet('100.00');
    let runs = 0;
    const alwaysViolates: UnitOfWork = {
      run: async () => {
        runs += 1;
        throw new UniqueViolationError('wager_transactions_idempotency_key_key');
      },
    };

    await expect(useCase({ unitOfWork: alwaysViolates }).execute(wagerCommand(wallet), http, 'c')).rejects.toBeInstanceOf(
      UniqueViolationError,
    );
    expect(runs).toBe(2);
  });
});
