import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { noopLogger, type AppLogger } from '../../../src/application/ports/logger';
import { noopMetrics } from '../../../src/application/ports/metrics';
import { GetTransaction } from '../../../src/application/use-cases/get-transaction';
import { GetWallet } from '../../../src/application/use-cases/get-wallet';
import { ListLedger } from '../../../src/application/use-cases/list-ledger';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { ReconcileWallet } from '../../../src/application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction.types';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId, testOrm } from '../../support/persistence';
import { fixedClock, recordingMetrics, wagerCommand, type WalletRef } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
const clock = fixedClock();
const ids = new UuidV7IdGenerator();
const tampered = new Set<string>();

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
  submitter = new SubmitWagerTransaction(uow, clock, ids, { hit: () => {} }, noopMetrics, () => 0);
});

afterEach(async () => {
  const sound = (await db.sql`SELECT id FROM wallets`).map((r: { id: string }) => r.id).filter((id: string) => !tampered.has(id));
  await assertLedgerConsistency(db.sql, sound);
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
let submitter: SubmitWagerTransaction;
const submit = (wallet: WalletRef, over: Parameters<typeof wagerCommand>[1] = {}) =>
  submitter.execute(wagerCommand(wallet, over), { type: 'http' }, 'corr');

function openWallet(amount = '100.00'): Promise<WalletRef> {
  return new OpenWallet(uow, clock, ids, noopMetrics).execute({ playerId: newId(), initialBalance: brl(amount), correlationId: 'open' });
}

/** Opens a wallet and appends `extra` WIN entries of 1.00 (versions 2..extra+1). */
async function walletWithEntries(extra: number): Promise<WalletRef> {
  const wallet = await openWallet('10.00');
  for (let i = 0; i < extra; i++) await submit(wallet, { kind: WagerTransactionKind.Win, money: brl('1.00') });
  return wallet;
}

describe('GetWallet', () => {
  test('returns the wallet view; unknown → NOT_FOUND', async () => {
    const wallet = await openWallet('42.00');
    expect(await new GetWallet(uow).execute(wallet.id)).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: brl('42.00'),
      version: 1,
    });
    await expect(new GetWallet(uow).execute(newId())).rejects.toMatchObject({ name: 'ApplicationError', code: 'NOT_FOUND' });
  });
});

describe('ListLedger', () => {
  test('paginates 120 entries with limit 50 into 50/50/20 then nextCursor null, no gaps or repeats', async () => {
    const wallet = await walletWithEntries(119);
    const list = new ListLedger(uow);

    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await list.execute(wallet.id, cursor, 50);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
    const versions = pages.flatMap((p) => p.items.map((i) => i.walletVersion));
    expect(versions).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(pages[0]?.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
      walletVersion: 1,
      createdAt: clock.now().toISOString(),
    });
  }, 60_000);

  test('exactly limit entries remaining → nextCursor null', async () => {
    const wallet = await walletWithEntries(2);
    const page = await new ListLedger(uow).execute(wallet.id, undefined, 3);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  test('cursor is stable while new entries are appended during pagination', async () => {
    const wallet = await walletWithEntries(5);
    const list = new ListLedger(uow);
    const first = await list.execute(wallet.id, undefined, 3);
    await submit(wallet, { kind: WagerTransactionKind.Win, money: brl('1.00') });
    const second = await list.execute(wallet.id, first.nextCursor!, 3);
    const third = await list.execute(wallet.id, second.nextCursor!, 3);

    const versions = [...first.items, ...second.items, ...third.items].map((i) => i.walletVersion);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(third.nextCursor).toBeNull();
  });

  test('empty ledger → no items, no cursor; unknown wallet → NOT_FOUND', async () => {
    const empty = await openWallet('0.00');
    expect(await new ListLedger(uow).execute(empty.id)).toEqual({ items: [], nextCursor: null });
    await expect(new ListLedger(uow).execute(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test.each([0, 201, 1.5, Number.NaN, -1])('limit %p → INVALID_PAYLOAD', async (limit) => {
    const wallet = await openWallet();
    await expect(new ListLedger(uow).execute(wallet.id, undefined, limit)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  test('invalid cursor → INVALID_CURSOR', async () => {
    const wallet = await openWallet();
    await expect(new ListLedger(uow).execute(wallet.id, '!!!')).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('GetTransaction', () => {
  test('by id and by provider external id; unknown → NOT_FOUND', async () => {
    const wallet = await openWallet('100.00');
    const cmd = wagerCommand(wallet, { money: brl('30.00') });
    const result = await submitter.execute(cmd, { type: 'http' }, 'corr');
    const get = new GetTransaction(uow);

    const view = await get.byId(result.transactionId);
    expect(view).toMatchObject({
      id: result.transactionId,
      providerId: 'provider-a',
      externalTransactionId: cmd.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('30.00'),
      status: 'PROCESSED',
      observedBalance: brl('70.00'),
      createdAt: clock.now().toISOString(),
      processedAt: clock.now().toISOString(),
    });
    expect(await get.byExternalId('provider-a', cmd.externalTransactionId)).toEqual(view);

    await expect(get.byId(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(get.byExternalId('provider-a', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(get.byExternalId('other-provider', cmd.externalTransactionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ReconcileWallet', () => {
  const errors: Array<[object, string]> = [];
  const logger: AppLogger = { ...noopLogger, error: (obj, msg) => errors.push([obj, msg]) };
  beforeEach(() => {
    errors.length = 0;
  });

  test('consistent wallet returns the contract with checkedEntries and signals nothing', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, { money: brl('30.00') });
    const metrics = recordingMetrics();

    expect(await new ReconcileWallet(uow, metrics, logger).execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('70.00'),
      calculatedBalance: brl('70.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
    expect(metrics.named('reconciliationMismatch')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('detects tampering (balance changed with triggers disabled) → consistent false, metric, money-free log, wallet untouched', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, { money: brl('30.00') });
    tampered.add(wallet.id);
    await db.sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 999.00 WHERE id = ${wallet.id}`;
    });
    const metrics = recordingMetrics();

    const result = await new ReconcileWallet(uow, metrics, logger).execute(wallet.id);

    expect(result).toEqual({
      walletId: wallet.id,
      storedBalance: brl('999.00'),
      calculatedBalance: brl('70.00'),
      difference: brl('929.00'),
      consistent: false,
      checkedEntries: 2,
    });
    expect(metrics.named('reconciliationMismatch')).toEqual([[]]);
    expect(errors).toEqual([[{ walletId: wallet.id, checkedEntries: 2, consistent: false }, 'wallet reconciliation mismatch']]);
    expect(JSON.stringify(errors)).not.toMatch(/999|929|balance/i);
    const [row] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(row).toEqual({ balance: '999.00', version: 2 });
  });

  test('wallet with a negative difference reports it signed', async () => {
    const wallet = await openWallet('100.00');
    tampered.add(wallet.id);
    await db.sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 40.00 WHERE id = ${wallet.id}`;
    });
    const result = await new ReconcileWallet(uow, noopMetrics, logger).execute(wallet.id);
    expect(result).toMatchObject({ consistent: false, difference: brl('-60.00') });
  });

  test('unknown wallet → NOT_FOUND', async () => {
    await expect(new ReconcileWallet(uow, noopMetrics, logger).execute(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
