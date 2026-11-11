import { Money } from '../../../domain/money/money';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { WagerTransactionRecord } from '../schemas/wager-transaction.schema';

export function wagerTransactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.from({ amount, currency: r.currency });
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId ?? undefined,
    gameId: r.gameId ?? undefined,
    kind: r.kind,
    money: money(r.amount),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    status: r.status,
    failureCode: r.failureCode ?? undefined,
    observedBalance: r.observedBalance == null ? undefined : money(r.observedBalance),
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    processedAt: r.processedAt ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function wagerTransactionToRecord(t: WagerTransaction): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId ?? null,
    gameId: t.gameId ?? null,
    kind: t.kind,
    amount: t.money.toJSON().amount,
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    observedBalance: t.observedBalance?.toJSON().amount ?? null,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt ?? null,
    processedAt: t.processedAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
