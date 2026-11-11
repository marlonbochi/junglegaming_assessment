import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrm } from '../../mikro-orm.config';
import type { TxRepositories } from '../../src/application/ports/unit-of-work';
import { OutboxMessage, type OutboxMessageState } from '../../src/domain/messaging/outbox-message';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, now, tx, type TxOverrides } from './fixtures';

export const newId = (): string => Bun.randomUUIDv7();

export function testOrm(url: string): Promise<MikroORM> {
  return createOrm({ DATABASE_URL: url, DB_POOL_MAX: 5 });
}

/** A promise that stays pending until `release()` is called. */
export function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Opens a wallet and persists it with its OPENING transaction and ledger entry, like OpenWallet does. */
export async function persistOpenedWallet(
  r: TxRepositories,
  amount = '1000.00',
): Promise<{ wallet: Wallet; opening?: WagerTransaction; entry?: WalletLedgerEntry }> {
  const walletId = newId();
  const playerId = newId();
  const openingTransactionId = newId();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(amount),
    openingTransactionId,
    openingEntryId: newId(),
    now,
  });
  await r.wallets.insert(wallet);
  if (!openingEntry) return { wallet };
  const opening = WagerTransaction.createOpening({ id: openingTransactionId, walletId, playerId, money: wallet.balance, now });
  await r.transactions.insert(opening);
  await r.ledger.append(openingEntry);
  return { wallet, opening, entry: openingEntry };
}

/** A new PENDING transaction on `wallet`, with real uuids. */
export function walletTx(wallet: Wallet, overrides: TxOverrides = {}): WagerTransaction {
  return tx({ id: newId(), walletId: wallet.id, playerId: wallet.playerId, ...overrides });
}

/** Persists a processed BET (debit) or WIN (credit) and the wallet move it causes. */
export async function persistMove(
  r: TxRepositories,
  wallet: Wallet,
  kind: 'BET' | 'WIN',
  amount: string,
  at: Date = now,
): Promise<{ transaction: WagerTransaction; entry: WalletLedgerEntry }> {
  const transaction = walletTx(wallet, { kind, money: brl(amount) });
  const change = { money: transaction.money, transactionId: transaction.id, entryId: newId(), now: at };
  const entry = kind === 'BET' ? wallet.debit(change) : wallet.credit(change);
  transaction.markProcessed(undefined, wallet.balance, at);
  await r.transactions.insert(transaction);
  await r.ledger.append(entry);
  await r.wallets.update(wallet);
  return { transaction, entry };
}

export function outboxMessage(overrides: Partial<OutboxMessageState> = {}): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: newId(),
    aggregateId: newId(),
    eventType: 'WalletBalanceChanged',
    payload: { amount: '10.00', nested: { list: [1, 'two'] } },
    occurredAt: now,
    attempts: 0,
    nextAttemptAt: now,
    ...overrides,
  });
}
