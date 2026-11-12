import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-transaction.types';
import { wagerTransactionToDomain, wagerTransactionToRecord } from '../mappers/wager-transaction.mapper';
import { WagerTransactionSchema, type WagerTransactionRecord } from '../schemas/wager-transaction.schema';
import { assertSingleRow, FRESH } from './read-options';

const toDomain = (r: WagerTransactionRecord | null) => (r ? wagerTransactionToDomain(r) : undefined);

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return toDomain(await this.em.findOne(WagerTransactionSchema, { id }, FRESH));
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    return toDomain(
      await this.em.findOne(WagerTransactionSchema, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE }),
    );
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return toDomain(await this.em.findOne(WagerTransactionSchema, { idempotencyKey: key }, FRESH));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return toDomain(await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }, FRESH));
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId: transactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return reversals > 0;
  }

  async insert(t: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, wagerTransactionToRecord(t));
  }

  async update(t: WagerTransaction): Promise<void> {
    const { id, ...changes } = wagerTransactionToRecord(t);
    assertSingleRow(await this.em.nativeUpdate(WagerTransactionSchema, { id }, changes), `wager transaction ${id}`);
  }

  /** Only the caller's (locked) wallet: dependents in other wallets would be written without their wallet lock. */
  nudgeDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        walletId,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
      },
      { nextAttemptAt: now },
    );
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { ...FRESH, fields: ['id', 'walletId'], orderBy: { nextAttemptAt: 'asc', id: 'asc' }, limit },
    );
    return records.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionSchema, { status: WagerTransactionStatus.PendingReference });
  }
}
