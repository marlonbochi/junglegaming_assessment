import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { UniqueViolationError } from '../../../src/application/errors';
import { noopMetrics } from '../../../src/application/ports/metrics';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction.types';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { brl, now } from '../../support/fixtures';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  newId,
  outboxMessage,
  persistMove,
  persistOpenedWallet,
  testOrm,
  walletTx,
} from '../../support/persistence';

const later = (ms: number) => new Date(now.getTime() + ms);

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
});

afterAll(async () => {
  // Constitution #26: every wallet these tests touched still matches its ledger.
  await assertLedgerConsistency(db.sql);
  await orm.close(true);
  await db.drop();
});

describe('wallets', () => {
  test('wallet roundtrip keeps Money exact and as string', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '1000.00'));

    const found = await uow.run((r) => r.wallets.findById(wallet.id));

    expect(found?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(found?.toState()).toEqual(wallet.toState());
    const [row] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe('1000.00');
  });

  test('update persists balance, version and updatedAt; lockById reads the committed row', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '0.10'));
    await uow.run((r) => persistMove(r, wallet, 'WIN', '99999999999999999.89', later(1000)));

    const locked = await uow.run((r) => r.wallets.lockById(wallet.id));

    expect(locked?.balance.toJSON()).toEqual({ amount: '99999999999999999.99', currency: 'BRL' });
    expect(locked?.version).toBe(2);
    expect(locked?.updatedAt).toEqual(later(1000));
  });

  test('reads inside a transaction see the writes made earlier in it', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '50.00'));

    const after = await uow.run(async (r) => {
      const loaded = await r.wallets.lockById(wallet.id);
      await persistMove(r, loaded!, 'BET', '20.00');
      return r.wallets.findById(wallet.id);
    });

    expect(after?.version).toBe(2);
    expect(after?.balance.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  test('missing wallet is undefined', async () => {
    expect(await uow.run((r) => r.wallets.findById(newId()))).toBeUndefined();
    expect(await uow.run((r) => r.wallets.lockById(newId()))).toBeUndefined();
  });
});

describe('wager transactions', () => {
  test('transaction roundtrip preserves every field incl. undefined round/game for OPENING', async () => {
    const { opening } = await uow.run((r) => persistOpenedWallet(r));

    const found = await uow.run((r) => r.transactions.findById(opening!.id));

    expect(found?.toState()).toEqual(opening!.toState());
    expect(found?.roundId).toBeUndefined();
    expect(found?.gameId).toBeUndefined();
    expect(found?.money.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  test('pending reference, processed reversal and rejection roundtrip every lifecycle column', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const { transaction: bet } = await uow.run((r) => persistMove(r, wallet, 'BET', '25.00'));
    const refund = walletTx(wallet, {
      kind: 'REFUND',
      money: brl('25.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    refund.markPendingReference(later(2000), later(10));
    await uow.run((r) => r.transactions.insert(refund));

    expect((await uow.run((r) => r.transactions.findById(refund.id)))?.toState()).toEqual(refund.toState());

    await uow.run(async (r) => {
      const entry = wallet.credit({ money: refund.money, transactionId: refund.id, entryId: newId(), now: later(20) });
      refund.markProcessed(bet.id, wallet.balance, later(20));
      await r.transactions.update(refund);
      await r.ledger.append(entry);
      await r.wallets.update(wallet);
    });
    const processed = await uow.run((r) => r.transactions.findById(refund.id));
    expect(processed?.toState()).toEqual(refund.toState());
    expect(processed?.referenceTransactionId).toBe(bet.id);
    expect(processed?.nextAttemptAt).toBeUndefined();

    const rejected = walletTx(wallet, { kind: 'BET', money: brl('5000.00') });
    rejected.reject(FailureCode.InsufficientFunds, wallet.balance, later(30));
    await uow.run((r) => r.transactions.insert(rejected));
    const found = await uow.run((r) => r.transactions.findById(rejected.id));
    expect(found?.toState()).toEqual(rejected.toState());
    expect(found?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(found?.observedBalance?.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  test('finds by idempotency key and by external id; lockById returns the row', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const { transaction } = await uow.run((r) => persistMove(r, wallet, 'BET', '1.00'));

    const byKey = await uow.run((r) => r.transactions.findByIdempotencyKey(transaction.idempotencyKey));
    const byExternal = await uow.run((r) =>
      r.transactions.findByExternalId(transaction.providerId, transaction.externalTransactionId),
    );
    const locked = await uow.run((r) => r.transactions.lockById(transaction.id));

    expect(byKey?.id).toBe(transaction.id);
    expect(byExternal?.id).toBe(transaction.id);
    expect(locked?.toState()).toEqual(transaction.toState());
    expect(await uow.run((r) => r.transactions.findByIdempotencyKey('missing'))).toBeUndefined();
    expect(await uow.run((r) => r.transactions.findByExternalId('provider-z', 'missing'))).toBeUndefined();
    expect(await uow.run((r) => r.transactions.lockById(newId()))).toBeUndefined();
  });

  test('duplicate idempotency key surfaces as UniqueViolationError with the constraint name', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const first = walletTx(wallet);
    await uow.run((r) => r.transactions.insert(first));

    const duplicate = walletTx(wallet, { idempotencyKey: first.idempotencyKey });
    const error = await uow.run((r) => r.transactions.insert(duplicate)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wager_transactions_idempotency_key_key');
  });

  test('isReversed true only for PROCESSED REFUND/ROLLBACK pointing to the id', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const bet = async () => (await uow.run((r) => persistMove(r, wallet, 'BET', '10.00'))).transaction;
    const refunded = await bet();
    const rolledBack = await bet();
    const pendingRefund = await bet();
    const won = await bet();
    const untouched = await bet();

    await uow.run(async (r) => {
      for (const [original, kind] of [
        [refunded, 'REFUND'],
        [rolledBack, 'ROLLBACK'],
        [won, 'WIN'],
      ] as const) {
        const t = walletTx(wallet, {
          kind,
          money: brl('10.00'),
          referenceExternalTransactionId: original.externalTransactionId,
        });
        const entry = wallet.credit({ money: t.money, transactionId: t.id, entryId: newId(), now });
        t.markProcessed(original.id, wallet.balance, now);
        await r.transactions.insert(t);
        await r.ledger.append(entry);
        await r.wallets.update(wallet);
      }
      const pending = walletTx(wallet, {
        kind: 'REFUND',
        money: brl('10.00'),
        referenceExternalTransactionId: pendingRefund.externalTransactionId,
      });
      pending.markPendingReference(later(1000), now);
      await r.transactions.insert(pending);
    });

    const reversed = await uow.run(async (r) =>
      Promise.all([refunded, rolledBack, pendingRefund, won, untouched].map((t) => r.transactions.isReversed(t.id))),
    );
    expect(reversed).toEqual([true, true, false, false, false]);
  });

  test('nudgeDependents sets next_attempt_at = now for PENDING_REFERENCE dependents of the same wallet only', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const { wallet: otherWallet } = await uow.run((r) => persistOpenedWallet(r));
    const pendingOn = (provider: string, reference: string, kind: 'REFUND' | 'WIN' = 'REFUND', on = wallet) => {
      const t = walletTx(on, { kind, providerId: provider, referenceExternalTransactionId: reference });
      t.markPendingReference(later(60_000), now);
      return t;
    };
    const dependentA = pendingOn('provider-a', 'ext-target');
    const dependentB = pendingOn('provider-a', 'ext-target', 'WIN');
    const otherProvider = pendingOn('provider-b', 'ext-target');
    const otherReference = pendingOn('provider-a', 'ext-other');
    // Constitution #10: its wallet is not locked by the caller, so it must not be touched.
    const otherWalletDependent = pendingOn('provider-a', 'ext-target', 'REFUND', otherWallet);
    const rejected = walletTx(wallet, { kind: 'WIN', referenceExternalTransactionId: 'ext-target' });
    rejected.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
    await uow.run(async (r) => {
      for (const t of [dependentA, dependentB, otherProvider, otherReference, otherWalletDependent, rejected]) {
        await r.transactions.insert(t);
      }
    });

    const nudgeAt = later(5);
    const count = await uow.run((r) => r.transactions.nudgeDependents(wallet.id, 'provider-a', 'ext-target', nudgeAt));

    expect(count).toBe(2);
    const reload = (id: string) => uow.run((r) => r.transactions.findById(id));
    expect((await reload(dependentA.id))?.nextAttemptAt).toEqual(nudgeAt);
    expect((await reload(dependentB.id))?.nextAttemptAt).toEqual(nudgeAt);
    expect((await reload(otherProvider.id))?.nextAttemptAt).toEqual(later(60_000));
    expect((await reload(otherReference.id))?.nextAttemptAt).toEqual(later(60_000));
    expect((await reload(otherWalletDependent.id))?.nextAttemptAt).toEqual(later(60_000));
    expect((await reload(rejected.id))?.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('findDuePendingReferences returns due candidates oldest first; countPendingReferences counts all', async () => {
    const countBefore = await uow.run((r) => r.transactions.countPendingReferences());
    const { wallet } = await uow.run((r) => persistOpenedWallet(r));
    const pendingAt = (ms: number) => {
      const t = walletTx(wallet, { kind: 'REFUND', referenceExternalTransactionId: `missing-${newId()}` });
      t.markPendingReference(later(ms), now);
      return t;
    };
    const dueLate = pendingAt(-1000);
    const dueEarly = pendingAt(-5000);
    const notDue = pendingAt(60_000);
    await uow.run(async (r) => {
      for (const t of [dueLate, dueEarly, notDue]) await r.transactions.insert(t);
    });

    const due = await uow.run((r) => r.transactions.findDuePendingReferences(now, 10));
    const firstOnly = await uow.run((r) => r.transactions.findDuePendingReferences(now, 1));

    const mine = due.filter((d) => d.walletId === wallet.id);
    expect(mine).toEqual([
      { id: dueEarly.id, walletId: wallet.id },
      { id: dueLate.id, walletId: wallet.id },
    ]);
    expect(firstOnly).toHaveLength(1);
    expect(await uow.run((r) => r.transactions.countPendingReferences())).toBe(countBefore + 3);
  });
});

describe('ledger', () => {
  test('ledger listByWallet is ordered by walletVersion and respects afterVersion/limit', async () => {
    const { wallet, entry: opening } = await uow.run((r) => persistOpenedWallet(r, '100.00'));
    const moves = [];
    for (const [kind, amount] of [
      ['BET', '10.00'],
      ['WIN', '0.01'],
      ['BET', '90.01'],
    ] as const) {
      moves.push((await uow.run((r) => persistMove(r, wallet, kind, amount))).entry);
    }

    const all = await uow.run((r) => r.ledger.listByWallet(wallet.id, 0, 50));
    const page = await uow.run((r) => r.ledger.listByWallet(wallet.id, 1, 2));
    const tail = await uow.run((r) => r.ledger.listByWallet(wallet.id, 3, 50));

    expect(all.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(all).toEqual([opening!, ...moves]);
    expect(page.map((e) => e.walletVersion)).toEqual([2, 3]);
    expect(tail.map((e) => e.walletVersion)).toEqual([4]);
    expect(tail[0]?.balanceAfter.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await uow.run((r) => r.ledger.listByWallet(newId(), 0, 50))).toEqual([]);
  });

  test('ledger totals sums credits and debits exactly', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '1000.00'));
    for (const [kind, amount] of [
      ['BET', '25.10'],
      ['WIN', '100.05'],
      ['BET', '0.01'],
      ['WIN', '0.03'],
    ] as const) {
      await uow.run((r) => persistMove(r, wallet, kind, amount));
    }

    const totals = await uow.run((r) => r.ledger.totals(wallet.id, 'BRL'));

    expect(totals.credits.toJSON()).toEqual({ amount: '1100.08', currency: 'BRL' });
    expect(totals.debits.toJSON()).toEqual({ amount: '25.11', currency: 'BRL' });
    expect(totals.count).toBe(5);
    expect(totals.lastBalanceAfter?.toJSON()).toEqual({ amount: '1074.97', currency: 'BRL' });
    expect(totals.credits.subtract(totals.debits).equals(wallet.balance)).toBe(true);
  });

  test('ledger totals of a wallet without entries are zero', async () => {
    const { wallet } = await uow.run((r) => persistOpenedWallet(r, '0.00'));

    const totals = await uow.run((r) => r.ledger.totals(wallet.id, 'BRL'));

    expect(totals).toEqual({ credits: Money.zero('BRL'), debits: Money.zero('BRL'), count: 0, lastBalanceAfter: undefined });
  });
});

describe('inbox', () => {
  test('inbox roundtrip and duplicate (consumer, message) rejected by the primary key', async () => {
    const message = InboxMessage.receive({ messageId: newId(), consumerName: 'consumer-a', payloadHash: 'b'.repeat(64), now });
    await uow.run((r) => r.inbox.insert(message));

    const found = await uow.run((r) => r.inbox.find('consumer-a', message.messageId));
    const otherConsumer = await uow.run((r) => r.inbox.find('consumer-b', message.messageId));
    const duplicate = await uow.run((r) => r.inbox.insert(message)).catch((e: unknown) => e);

    expect(found).toEqual(message);
    expect(otherConsumer).toBeUndefined();
    expect(duplicate).toBeInstanceOf(UniqueViolationError);
    expect((duplicate as UniqueViolationError).constraint).toBe('inbox_messages_pkey');
  });
});

describe('outbox', () => {
  test('enqueue, save, pendingCount and lagSeconds', async () => {
    const pendingBefore = await uow.run((r) => r.outbox.pendingCount());
    const oldest = outboxMessage({ occurredAt: later(-90_000), nextAttemptAt: later(-90_000) });
    const retried = outboxMessage({ occurredAt: later(-30_000), nextAttemptAt: later(-30_000) });
    await uow.run(async (r) => {
      await r.outbox.enqueue(oldest);
      await r.outbox.enqueue(retried);
    });
    expect(await uow.run((r) => r.outbox.pendingCount())).toBe(pendingBefore + 2);
    expect(await uow.run((r) => r.outbox.lagSeconds(now))).toBeGreaterThanOrEqual(90);

    oldest.markPublished(now);
    retried.scheduleRetry(now, () => 0);
    await uow.run(async (r) => {
      await r.outbox.save(oldest);
      await r.outbox.save(retried);
    });

    expect(await uow.run((r) => r.outbox.pendingCount())).toBe(pendingBefore + 1);
    const due = await uow.run((r) => r.outbox.lockDueBatch(later(60_000), 100));
    expect(due.find((m) => m.id === oldest.id)).toBeUndefined();
    expect(due.find((m) => m.id === retried.id)).toEqual(retried);
    expect(retried.attempts).toBe(1);
  });

  test('lockDueBatch skips published and not-yet-due messages, oldest first', async () => {
    const at = later(3_600_000);
    const first = outboxMessage({ occurredAt: later(3_000_000), nextAttemptAt: later(3_000_000) });
    const second = outboxMessage({ occurredAt: later(3_100_000), nextAttemptAt: later(3_100_000) });
    const notDue = outboxMessage({ occurredAt: later(3_000_000), nextAttemptAt: later(4_000_000) });
    const published = outboxMessage({ occurredAt: later(3_000_000), nextAttemptAt: undefined, publishedAt: now });
    await uow.run(async (r) => {
      for (const m of [second, first, notDue, published]) await r.outbox.enqueue(m);
    });

    const batch = await uow.run((r) => r.outbox.lockDueBatch(at, 1000));
    const ids = batch.map((m) => m.id);

    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(ids).not.toContain(notDue.id);
    expect(ids).not.toContain(published.id);
    expect(await uow.run((r) => r.outbox.lagSeconds(later(-10_000_000)))).toBe(0);
  });
});
