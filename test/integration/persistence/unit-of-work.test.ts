import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfraError, UniqueViolationError } from '../../../src/application/errors';
import { noopMetrics, type Metrics } from '../../../src/application/ports/metrics';
import type { TxRepositories } from '../../../src/application/ports/unit-of-work';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { eventually } from '../../support/eventually';
import { brl, now } from '../../support/fixtures';
import {
  latch,
  newId,
  outboxMessage,
  persistMove,
  persistOpenedWallet,
  testOrm,
} from '../../support/persistence';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

function countingMetrics(): Metrics & { lockConflicts: number } {
  const metrics = { ...noopMetrics, lockConflicts: 0 };
  metrics.lockConflict = () => {
    metrics.lockConflicts += 1;
  };
  return metrics;
}

/** Waits until exactly `n` backends of this test database are blocked on a row lock. */
function waitForLockWaiters(n: number): Promise<void> {
  return eventually(async () => {
    const [row] = await db.sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(row.waiting).toBe(n);
  });
}

/** Runs a transaction that locks a row and keeps it locked until the returned `release` is called. */
async function holdLock(lock: (r: TxRepositories) => Promise<unknown>) {
  const locked = latch();
  const done = latch();
  const finished = uow.run(async (r) => {
    await lock(r);
    locked.release();
    await done.promise;
  });
  await locked.promise;
  return {
    release: async () => {
      done.release();
      await finished;
    },
  };
}

describe('MikroOrmUnitOfWork', () => {
  test('lockById blocks a second locker until commit', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '100.00'));
    const events: string[] = [];
    const locked = latch();
    const release = latch();

    const first = uow.run(async (r) => {
      const w = await r.wallets.lockById(wallet.id);
      events.push('A:locked');
      locked.release();
      await release.promise;
      await persistMove(r, w!, 'BET', '40.00');
      events.push('A:wrote');
    });
    await locked.promise;
    const second = uow.run(async (r) => {
      const w = await r.wallets.lockById(wallet.id);
      events.push('B:locked');
      return w;
    });

    await waitForLockWaiters(1);
    expect(events).toEqual(['A:locked']);
    release.release();
    const [, seenBySecond] = await Promise.all([first, second]);

    expect(events).toEqual(['A:locked', 'A:wrote', 'B:locked']);
    expect(seenBySecond?.version).toBe(2);
    expect(seenBySecond?.balance.toJSON()).toEqual({ amount: '60.00', currency: 'BRL' });
  });

  test('unit of work rolls back everything when fn throws', async () => {
    const boom = new Error('boom');
    const { wallet } = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('0.00'),
      openingTransactionId: newId(),
      openingEntryId: newId(),
      now,
    });
    const message = InboxMessage.receive({ messageId: newId(), consumerName: 'c', payloadHash: 'c'.repeat(64), now });
    const outbox = outboxMessage();

    const error = await uow
      .run(async (r) => {
        await r.wallets.insert(wallet);
        await r.inbox.insert(message);
        await r.outbox.enqueue(outbox);
        throw boom;
      })
      .catch((e: unknown) => e);

    expect(error).toBe(boom);
    const [row] = await db.sql`
      SELECT (SELECT count(*) FROM wallets WHERE id = ${wallet.id})::int
           + (SELECT count(*) FROM inbox_messages WHERE message_id = ${message.messageId})::int
           + (SELECT count(*) FROM outbox_messages WHERE id = ${outbox.id})::int AS leftovers`;
    expect(row.leftovers).toBe(0);
  });

  test.each(['wallet', 'transaction'] as const)(
    'unit of work maps lock timeout on a %s lock to TransientInfraError',
    async (target) => {
      const { wallet, opening } = await uow.run((r) => persistOpenedWallet(r, '10.00'));
      const lock = (r: TxRepositories): Promise<unknown> =>
        target === 'wallet' ? r.wallets.lockById(wallet.id) : r.transactions.lockById(opening!.id);
      const holder = await holdLock(lock);
      const metrics = countingMetrics();
      const impatient = new MikroOrmUnitOfWork(orm, metrics, { lockTimeoutMs: 100 });

      const error = await impatient.run(lock).catch((e: unknown) => e);
      await holder.release();

      expect(error).toBeInstanceOf(TransientInfraError);
      expect(metrics.lockConflicts).toBe(1);
    },
  );

  test('statement timeout is transient but not a lock conflict', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '10.00'));
    const holder = await holdLock((r) => r.wallets.lockById(wallet.id));
    const metrics = countingMetrics();
    const impatient = new MikroOrmUnitOfWork(orm, metrics, { lockTimeoutMs: 10_000, statementTimeoutMs: 100 });

    const error = await impatient.run((r) => r.wallets.lockById(wallet.id)).catch((e: unknown) => e);
    await holder.release();

    expect(error).toBeInstanceOf(TransientInfraError);
    expect(metrics.lockConflicts).toBe(0);
  });

  test('unique violation becomes UniqueViolationError and rolls back', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '0.00'));
    const sameOwner = Wallet.rehydrate({ ...wallet.toState(), id: newId() });
    const outbox = outboxMessage();

    const error = await uow
      .run(async (r) => {
        await r.outbox.enqueue(outbox);
        await r.wallets.insert(sameOwner);
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wallets_player_id_currency_key');
    const [row] = await db.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE id = ${outbox.id}`;
    expect(row.n).toBe(0);
  });

  test('schema guard violations propagate unchanged', async () => {
    const { wallet } = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('5.00'),
      openingTransactionId: newId(),
      openingEntryId: newId(),
      now,
    });

    // Balance without its opening ledger entry: rejected by the deferred trigger at COMMIT.
    const error = await uow.run((r) => r.wallets.insert(wallet)).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TransientInfraError);
    expect(error).not.toBeInstanceOf(UniqueViolationError);
    expect(error).toMatchObject({ code: '23000', constraint: 'wallets_ledger_consistency' });
  });

  test('outbox lockDueBatch with SKIP LOCKED returns disjoint batches to two concurrent callers', async () => {
    const at = new Date('2030-01-01T00:00:00Z');
    const messages = Array.from({ length: 6 }, (_, i) =>
      outboxMessage({ occurredAt: new Date(at.getTime() - 60_000 + i), nextAttemptAt: new Date(at.getTime() - 60_000 + i) }),
    );
    await uow.run(async (r) => {
      for (const m of messages) await r.outbox.enqueue(m);
    });
    const mine = new Set(messages.map((m) => m.id));

    let firstBatch: string[] = [];
    const holder = await holdLock(async (r) => {
      firstBatch = (await r.outbox.lockDueBatch(at, 3)).map((m) => m.id);
    });
    const secondBatch = (await uow.run((r) => r.outbox.lockDueBatch(at, 100))).map((m) => m.id).filter((id) => mine.has(id));
    await holder.release();

    expect(firstBatch).toHaveLength(3);
    expect(secondBatch).toHaveLength(3);
    expect(new Set([...firstBatch, ...secondBatch])).toEqual(mine);
  });
});
