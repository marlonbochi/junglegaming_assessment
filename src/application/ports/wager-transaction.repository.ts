import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  isReversed(transactionId: string): Promise<boolean>;
  insert(t: WagerTransaction): Promise<void>;
  update(t: WagerTransaction): Promise<void>;
  /** Makes due now the PENDING_REFERENCE transactions of `walletId` (locked by the caller) waiting for this one. */
  nudgeDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  countPendingReferences(): Promise<number>;
}
