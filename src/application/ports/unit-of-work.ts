import type { InboxRepository } from './inbox.repository';
import type { LedgerRepository } from './ledger.repository';
import type { OutboxRepository } from './outbox.repository';
import type { WagerTransactionRepository } from './wager-transaction.repository';
import type { WalletRepository } from './wallet.repository';

export interface TxRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  /** Defaults to the database default (read committed). */
  isolation?: 'repeatable read';
  /** Server-side bound on time spent idle inside the transaction (e.g. waiting on a remote call). */
  idleInTransactionTimeoutMs?: number;
}

export interface UnitOfWork {
  run<T>(fn: (r: TxRepositories) => Promise<T>, opts?: UnitOfWorkOptions): Promise<T>;
}
