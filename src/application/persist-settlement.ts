import type { IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import type { ReferenceLookup, SettlementResult } from '../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { IdGenerator } from './ports/clock';
import type { FaultInjector } from './ports/fault-injector';
import type { TxRepositories } from './ports/unit-of-work';

export interface SettledTransaction {
  tx: WagerTransaction;
  wallet: Wallet;
  settlement: SettlementResult;
  /** `insert` for a new transaction (submit), `update` for one already persisted (pending retry). */
  write: 'insert' | 'update';
  correlationId: string;
  now: Date;
}

/**
 * Spec §6.1 steps 5–6, shared by the submit and the pending-reference worker: persists the transaction,
 * the ledger entry and wallet (when the balance moved) and the resulting events, then makes pending
 * dependents of a decided transaction due now. Runs inside the caller's SQL transaction, wallet locked.
 */
export async function persistSettlement(
  r: TxRepositories,
  s: SettledTransaction,
  deps: { ids: IdGenerator; faults: FaultInjector },
): Promise<void> {
  const { tx, wallet, settlement } = s;
  if (s.write === 'insert') await r.transactions.insert(tx);
  else await r.transactions.update(tx);

  const entry = settlement.outcome === 'PROCESSED' ? settlement.ledgerEntry : undefined;
  if (entry) {
    await r.ledger.append(entry);
    deps.faults.hit('after_ledger_append');
    await r.wallets.update(wallet);
  }
  for (const event of eventsFor(s, deps.ids)) {
    await r.outbox.enqueue(OutboxMessage.enqueue(event));
  }

  // A decided transaction may be what pending dependents wait for. Only this (locked) wallet's: a
  // dependent in another wallet would be a REFERENCE_MISMATCH anyway and resolves on its own backoff.
  if (tx.isTerminal()) await r.transactions.nudgeDependents(tx.walletId, tx.providerId, tx.externalTransactionId, s.now);
}

/** The reference is read without a lock: same wallet is already locked, another wallet is a mismatch. */
export async function lookupReference(
  r: TxRepositories,
  providerId: string,
  referenceExternalTransactionId: string | undefined,
): Promise<ReferenceLookup> {
  if (!referenceExternalTransactionId) return { kind: 'none' };
  const transaction = await r.transactions.findByExternalId(providerId, referenceExternalTransactionId);
  if (!transaction) return { kind: 'missing' };
  return { kind: 'found', transaction, alreadyReversed: await r.transactions.isReversed(transaction.id) };
}

function eventsFor({ settlement, tx, wallet, correlationId, now }: SettledTransaction, ids: IdGenerator): IntegrationEvent<unknown>[] {
  const ctx = () => ({ eventId: ids.next(), correlationId, causationId: tx.id, occurredAt: now });
  switch (settlement.outcome) {
    case 'PROCESSED': {
      const processed = WagerTransactionProcessed.from(tx, wallet.balance, ctx());
      if (!settlement.ledgerEntry) return [processed];
      return [processed, WalletBalanceChanged.from(wallet, settlement.ledgerEntry, ctx())];
    }
    case 'REJECTED':
      return [WagerTransactionRejected.from(tx, wallet.balance, ctx())];
    case 'PENDING_REFERENCE':
      return [WagerTransactionPendingReference.from(tx, ctx())];
  }
}
