import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PermanentInfraError, TransientInfraError } from '../../../src/application/errors';
import { payloadHash } from '../../../src/application/hashing/payload-hash';
import type { FaultInjector, FaultPoint } from '../../../src/application/ports/fault-injector';
import type { AppLogger } from '../../../src/application/ports/logger';
import { noopMetrics } from '../../../src/application/ports/metrics';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction.types';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { EnvFaultInjector } from '../../../src/infrastructure/runtime/env-fault-injector';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId, testOrm } from '../../support/persistence';
import { fixedClock, recordingMetrics, wagerCommand, type WalletRef } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let metrics: ReturnType<typeof recordingMetrics>;
const clock = fixedClock();
const ids = new UuidV7IdGenerator();
const noFaults: FaultInjector = { hit: () => {} };

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
});

beforeEach(() => {
  metrics = recordingMetrics();
});

afterEach(() => assertLedgerConsistency(db.sql));

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const sqs = (messageId: string = newId()) => ({ type: 'sqs', consumerName: 'wager-consumer', messageId }) as const;

function useCase(faults: FaultInjector = noFaults, unitOfWork: UnitOfWork = uow, logger?: AppLogger) {
  return new SubmitWagerTransaction(unitOfWork, clock, ids, faults, metrics, () => 0, logger);
}

/** Collects every log call as [level, fields, message]. */
function recordingLogger(): AppLogger & { lines: Array<[string, object, string]> } {
  const lines: Array<[string, object, string]> = [];
  return {
    lines,
    info: (obj, msg) => void lines.push(['info', obj, msg]),
    warn: (obj, msg) => void lines.push(['warn', obj, msg]),
    error: (obj, msg) => void lines.push(['error', obj, msg]),
  };
}

/** What `pg` raises when the database host name does not resolve (e.g. a stopped compose service). */
const hostNotFound = () => Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), { code: 'ENOTFOUND' });

function openWallet(amount = '100.00'): Promise<WalletRef> {
  return new OpenWallet(uow, clock, ids, noopMetrics).execute({
    playerId: newId(),
    initialBalance: brl(amount),
    correlationId: 'open',
  });
}

/** A fault injector that raises an unclassified error (a bug, not an infra failure) at `point`. */
function crashingAt(point: FaultPoint): FaultInjector {
  return {
    hit: (p) => {
      if (p === point) throw new Error(`boom at ${p}`);
    },
  };
}

async function snapshot(walletId: string, messageId: string) {
  const [row] = await db.sql`
    SELECT (SELECT balance::text FROM wallets WHERE id = ${walletId}) AS balance,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version,
           (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS events,
           (SELECT count(*)::int FROM inbox_messages WHERE message_id = ${messageId}) AS inbox`;
  return row;
}

async function txByKey(idempotencyKey: string) {
  return db.sql`
    SELECT id, status, failure_code, observed_balance::text AS observed_balance, payload_hash, kind,
           amount::text AS amount
      FROM wager_transactions WHERE idempotency_key = ${idempotencyKey}`;
}

describe('SubmitWagerTransaction atomicity', () => {
  test.each<FaultPoint>(['after_ledger_append', 'before_commit'])(
    'throw at %s leaves no tx, entry, wallet change, outbox or inbox',
    async (point) => {
      const wallet = await openWallet('100.00');
      const cmd = wagerCommand(wallet, { money: brl('30.00') });
      const message = sqs();
      const before = await snapshot(wallet.id, message.messageId);

      await expect(useCase(new EnvFaultInjector(`${point}:throw`)).execute(cmd, message, 'c')).rejects.toBeInstanceOf(
        TransientInfraError,
      );

      expect(await snapshot(wallet.id, message.messageId)).toEqual(before);
      expect(await txByKey(cmd.idempotencyKey)).toEqual([]); // a transient failure is not recorded as FAILED
      expect(metrics.named('transaction')).toEqual([]);

      // The redelivery succeeds as if the first attempt never happened.
      expect(await useCase().execute(cmd, message, 'c')).toMatchObject({ status: Status.Processed, idempotentReplay: false });
      expect(await snapshot(wallet.id, message.messageId)).toMatchObject({
        balance: '70.00',
        version: 2,
        transactions: before.transactions + 1,
        entries: before.entries + 1,
        events: before.events + 2,
        inbox: 1,
      });
    },
  );

  test('unexpected error after validation records FAILED with INTERNAL_PROCESSING_ERROR and rethrows PermanentInfraError', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, { money: brl('30.00') });
    const message = sqs();
    const before = await snapshot(wallet.id, message.messageId);

    const failure = useCase(crashingAt('after_ledger_append')).execute(cmd, message, 'c');
    await expect(failure).rejects.toBeInstanceOf(PermanentInfraError);
    await expect(failure).rejects.toMatchObject({ cause: { message: 'boom at after_ledger_append' } });

    const rows = await txByKey(cmd.idempotencyKey);
    expect(rows).toEqual([
      {
        id: expect.any(String),
        status: Status.Failed,
        failure_code: 'INTERNAL_PROCESSING_ERROR',
        observed_balance: null,
        payload_hash: payloadHash(cmd),
        kind: 'BET',
        amount: '30.00',
      },
    ]);
    // Only the FAILED row was added: no balance move, no entry, no event, no inbox.
    expect(await snapshot(wallet.id, message.messageId)).toEqual({ ...before, transactions: before.transactions + 1 });
    expect(metrics.named('transaction')).toEqual([['FAILED', 'BET', 'sqs']]);

    // FAILED is terminal: a replay returns it instead of processing again.
    expect(await useCase().execute(cmd, sqs(), 'c')).toEqual({
      transactionId: rows[0].id,
      status: Status.Failed,
      failureCode: FailureCode.InternalProcessingError,
      balance: brl('100.00'),
      idempotentReplay: true,
    });
  });

  test('FAILED is not recorded when the transaction already exists under that key: the outcome is unknown, so the error is transient and the retry is a replay', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    let runs = 0;
    // The first run commits, then the response is lost to an unexpected error.
    const losesResponse: UnitOfWork = {
      run: async (fn) => {
        const result = await uow.run(fn);
        if (runs++ === 0) throw new Error('lost after commit');
        return result;
      },
    };
    const logger = recordingLogger();

    const failure = useCase(noFaults, losesResponse, logger).execute(cmd, sqs(), 'c');
    await expect(failure).rejects.toBeInstanceOf(TransientInfraError);
    await expect(failure).rejects.toMatchObject({ cause: { message: 'lost after commit' } });
    expect((await txByKey(cmd.idempotencyKey)).map((r: { status: string }) => r.status)).toEqual(['PROCESSED']);
    expect(runs).toBe(2);
    expect(metrics.named('transaction')).toEqual([]);
    expect(logger.lines).toEqual([['warn', { cause: { type: 'Error' } }, 'commit outcome unknown; the retry resolves it as a replay']]);

    // The retry the transient error asks for is answered as a replay of the committed transaction.
    expect(await useCase().execute(cmd, sqs(), 'c')).toMatchObject({ status: Status.Processed, idempotentReplay: true });
  });

  test('if recording FAILED fails too, the error is transient, nothing is written and the write failure is logged by name and code', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet);
    const message = sqs();
    const before = await snapshot(wallet.id, message.messageId);
    let runs = 0;
    const downAfterFirstRun: UnitOfWork = {
      run: (fn) => (runs++ === 0 ? uow.run(fn) : Promise.reject(hostNotFound())),
    };
    const logger = recordingLogger();

    const failure = useCase(crashingAt('before_commit'), downAfterFirstRun, logger).execute(cmd, message, 'c');
    await expect(failure).rejects.toBeInstanceOf(TransientInfraError);
    await expect(failure).rejects.toMatchObject({ cause: { message: 'boom at before_commit' } });
    expect(await snapshot(wallet.id, message.messageId)).toEqual(before);
    expect(runs).toBe(2);
    expect(metrics.named('transaction')).toEqual([]);
    expect(logger.lines).toEqual([
      ['error', { error: { type: 'Error', code: 'ENOTFOUND' }, cause: { type: 'Error' } }, 'could not record the FAILED transaction'],
    ]);
    // Names and codes only: messages may carry row values.
    expect(JSON.stringify(logger.lines)).not.toContain('boom');
    expect(JSON.stringify(logger.lines)).not.toContain('getaddrinfo');
  });
});

describe('SubmitWagerTransaction on an unreachable database', () => {
  let unreachable: MikroORM;

  beforeAll(async () => {
    // `.invalid` never resolves (RFC 2606): pg fails with ENOTFOUND, like a stopped compose service.
    unreachable = await testOrm('postgres://postgres:postgres@postgres.invalid:5432/wagering');
  });

  afterAll(() => unreachable.close(true));

  test('a host that does not resolve is a transient failure, not a permanent one', async () => {
    const logger = recordingLogger();
    const cmd = wagerCommand({ id: newId(), playerId: newId() });

    const failure = useCase(noFaults, new MikroOrmUnitOfWork(unreachable, noopMetrics), logger).execute(cmd, sqs(), 'c');
    await expect(failure).rejects.toBeInstanceOf(TransientInfraError);
    await expect(failure).rejects.toMatchObject({ cause: { code: 'ENOTFOUND' } });
    expect(metrics.named('transaction')).toEqual([]);
    expect(logger.lines).toEqual([]);
  });
});
