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

export interface UnitOfWork {
  run<T>(fn: (r: TxRepositories) => Promise<T>): Promise<T>;
}
