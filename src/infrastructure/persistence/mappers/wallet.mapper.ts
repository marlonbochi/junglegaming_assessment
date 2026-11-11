import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import type { WalletRecord } from '../schemas/wallet.schema';

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balance, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toJSON().amount,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}
