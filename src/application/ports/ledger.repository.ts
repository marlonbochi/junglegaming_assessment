import type { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface LedgerRepository {
  append(e: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  totals(
    walletId: string,
    currency: string,
  ): Promise<{ credits: Money; debits: Money; count: number; lastBalanceAfter?: Money }>;
}
