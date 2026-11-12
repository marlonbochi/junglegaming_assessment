import type { Money, MoneyProps } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  kind: string;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
}

export function wagerTransactionData(tx: WagerTransaction, balance: Money): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    balance: balance.toJSON(),
    ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  };
}
