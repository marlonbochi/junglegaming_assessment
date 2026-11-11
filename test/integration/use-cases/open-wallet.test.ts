import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId, testOrm } from '../../support/persistence';
import { fixedClock, recordingMetrics } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
const clock = fixedClock();
const ids = new UuidV7IdGenerator();

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, recordingMetrics());
});

afterEach(() => assertLedgerConsistency(db.sql));

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const brlProps = (amount: string) => ({ amount, currency: 'BRL' });

function openWallet(over: { unitOfWork?: UnitOfWork; metrics?: ReturnType<typeof recordingMetrics> } = {}) {
  return new OpenWallet(over.unitOfWork ?? uow, clock, ids, over.metrics ?? recordingMetrics());
}

async function rowCounts(walletId: string) {
  const [row] = await db.sql`
    SELECT (SELECT count(*)::int FROM wallets WHERE id = ${walletId}) AS wallets,
           (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS events`;
  return row as { wallets: number; transactions: number; entries: number; events: number };
}

describe('OpenWallet', () => {
  test('opens with OPENING tx, CREDIT entry v1 and WalletBalanceChanged in outbox (same commit)', async () => {
    const playerId = newId();
    const metrics = recordingMetrics();
    const result = await openWallet({ metrics }).execute({
      playerId,
      initialBalance: brlProps('100.00'),
      correlationId: 'corr-1',
    });

    expect(result).toEqual({ id: expect.any(String), playerId, balance: brlProps('100.00'), version: 1 });

    const [wallet] = await db.sql`
      SELECT player_id, currency, balance::text AS balance, version FROM wallets WHERE id = ${result.id}`;
    expect(wallet).toEqual({ player_id: playerId, currency: 'BRL', balance: '100.00', version: 1 });

    const txs = await db.sql`
      SELECT id, provider_id, external_transaction_id, idempotency_key, kind, status, amount::text AS amount,
             observed_balance::text AS observed_balance, player_id
        FROM wager_transactions WHERE wallet_id = ${result.id}`;
    expect(txs).toHaveLength(1);
    const opening = txs[0];
    expect(opening).toMatchObject({
      provider_id: 'internal',
      external_transaction_id: result.id,
      idempotency_key: `opening:${result.id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '100.00',
      observed_balance: '100.00',
      player_id: playerId,
    });

    const entries = await db.sql`
      SELECT transaction_id, direction, amount::text AS amount, balance_before::text AS balance_before,
             balance_after::text AS balance_after, wallet_version
        FROM wallet_ledger_entries WHERE wallet_id = ${result.id}`;
    expect(entries).toEqual([
      {
        transaction_id: opening.id,
        direction: 'CREDIT',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
        wallet_version: 1,
      },
    ]);

    const events = await db.sql`SELECT id, event_type, payload FROM outbox_messages WHERE aggregate_id = ${result.id}`;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('WalletBalanceChanged');
    expect(events[0].payload).toMatchObject({
      eventId: events[0].id,
      eventType: 'WalletBalanceChanged',
      aggregateId: result.id,
      correlationId: 'corr-1',
      causationId: opening.id,
      occurredAt: clock.now().toISOString(),
      data: {
        walletId: result.id,
        playerId,
        transactionId: opening.id,
        direction: 'CREDIT',
        money: brlProps('100.00'),
        balanceBefore: brlProps('0.00'),
        balanceAfter: brlProps('100.00'),
        walletVersion: 1,
      },
    });
    expect(metrics.named('transaction')).toEqual([['PROCESSED', 'OPENING', 'internal']]);
  });

  test('a failure before commit leaves no wallet, tx, entry or event', async () => {
    const playerId = newId();
    const failing: UnitOfWork = {
      run: (fn) =>
        uow.run(async (r) => {
          await fn(r);
          throw new Error('abort before commit');
        }),
    };
    await expect(
      openWallet({ unitOfWork: failing }).execute({ playerId, initialBalance: brlProps('100.00'), correlationId: 'c' }),
    ).rejects.toThrow('abort before commit');

    const [row] = await db.sql`
      SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ${playerId}) AS wallets,
             (SELECT count(*)::int FROM wager_transactions WHERE player_id = ${playerId}) AS transactions`;
    expect(row).toEqual({ wallets: 0, transactions: 0 });
  });

  test('opens with zero balance: no tx, no entry, no event, version 1', async () => {
    const metrics = recordingMetrics();
    const result = await openWallet({ metrics }).execute({
      playerId: newId(),
      initialBalance: brlProps('0.00'),
      correlationId: 'corr-0',
    });

    expect(result).toMatchObject({ balance: brlProps('0.00'), version: 1 });
    expect(await rowCounts(result.id)).toEqual({ wallets: 1, transactions: 0, entries: 0, events: 0 });
    expect(metrics.named('transaction')).toEqual([]);
  });

  test('duplicate player+currency → WALLET_ALREADY_EXISTS; same player other currency is fine', async () => {
    const playerId = newId();
    const first = await openWallet().execute({ playerId, initialBalance: brlProps('10.00'), correlationId: 'c' });

    const duplicate = openWallet().execute({ playerId, initialBalance: brlProps('20.00'), correlationId: 'c' });
    await expect(duplicate).rejects.toBeInstanceOf(ApplicationError);
    await expect(duplicate).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });

    const usd = await openWallet().execute({
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
      correlationId: 'c',
    });
    expect(usd.id).not.toBe(first.id);

    const wallets = await db.sql`
      SELECT currency, balance::text AS balance FROM wallets WHERE player_id = ${playerId} ORDER BY currency`;
    expect(wallets).toEqual([
      { currency: 'BRL', balance: '10.00' },
      { currency: 'USD', balance: '5.00' },
    ]);
  });

  test('20 parallel opens for same player+currency → exactly 1 success, 19 WALLET_ALREADY_EXISTS', async () => {
    const playerId = newId();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        openWallet().execute({ playerId, initialBalance: brlProps('50.00'), correlationId: 'c' }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as ApplicationError).code] : []));
    expect(fulfilled).toHaveLength(1);
    expect(codes).toEqual(Array(19).fill('WALLET_ALREADY_EXISTS'));

    const [row] = await db.sql`
      SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ${playerId}) AS wallets,
             (SELECT count(*)::int FROM wager_transactions WHERE player_id = ${playerId}) AS transactions`;
    expect(row).toEqual({ wallets: 1, transactions: 1 });
  });

  test.each([
    ['negative amount', { amount: '-1.00', currency: 'BRL' }],
    ['one decimal', { amount: '1.5', currency: 'BRL' }],
    ['lowercase currency', { amount: '1.00', currency: 'brl' }],
  ])('%s → INVALID_PAYLOAD, nothing written', async (_name, initialBalance) => {
    const playerId = newId();
    await expect(openWallet().execute({ playerId, initialBalance, correlationId: 'c' })).rejects.toMatchObject({
      name: 'ApplicationError',
      code: 'INVALID_PAYLOAD',
    });
    const [row] = await db.sql`SELECT count(*)::int AS n FROM wallets WHERE player_id = ${playerId}`;
    expect(row.n).toBe(0);
  });
});
