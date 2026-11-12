import { Money } from '../../../domain/money/money';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import type { LedgerEntryRecord } from '../schemas/ledger-entry.schema';

export function ledgerEntryToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: r.currency });
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction,
    money: money(r.amount),
    balanceBefore: money(r.balanceBefore),
    balanceAfter: money(r.balanceAfter),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toJSON().amount,
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toJSON().amount,
    balanceAfter: e.balanceAfter.toJSON().amount,
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}
