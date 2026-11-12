import { computeNextAttemptAt, type BackoffPolicy } from '../../domain/messaging/backoff';
import { FailureCode } from '../../domain/shared/failure-code';
import { settle, type SettlementResult } from '../../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.types';
import { lookupReference, persistSettlement } from '../persist-settlement';
import type { Clock, IdGenerator } from '../ports/clock';
import type { FaultInjector } from '../ports/fault-injector';
import type { Metrics } from '../ports/metrics';
import type { TxRepositories, UnitOfWork } from '../ports/unit-of-work';

export interface PendingReferencePolicy {
  /** Worker attempts before giving up (spec §6.4: 10). */
  maxAttempts: number;
  /** Maximum age since `createdAt` (spec §6.4: 15 min). */
  ttlMs: number;
  backoff: BackoffPolicy;
}

export interface RetryPendingReferencesResult {
  resolved: number;
  rescheduled: number;
  expired: number;
}

type Retried = { result: keyof RetryPendingReferencesResult; tx: WagerTransaction };

/** Worker events have no request to correlate with: the transaction is both correlation and causation. */
const correlationOf = (tx: WagerTransaction) => tx.id;

/**
 * Spec §6.4: candidates are read without a lock; each one is retried in its own SQL transaction that
 * locks the wallet first, then the transaction, and skips it if another worker (or a submit) already
 * moved it. A reference that arrived resolves it like a submit would; while the reference is still
 * missing or undecided it is rescheduled, or rejected `REFERENCE_NOT_FOUND` once attempts or TTL ran out.
 */
export class RetryPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly policy: PendingReferencePolicy,
  ) {}

  async execute(limit: number): Promise<RetryPendingReferencesResult> {
    const now = this.clock.now();
    const candidates = await this.uow.run((r) => r.transactions.findDuePendingReferences(now, limit));
    const result: RetryPendingReferencesResult = { resolved: 0, rescheduled: 0, expired: 0 };
    const errors: unknown[] = [];
    // One failing candidate must not starve the others; the failures are raised after the batch.
    for (const candidate of candidates) {
      try {
        const retried = await this.uow.run((r) => this.retry(r, candidate, now));
        if (!retried) continue;
        result[retried.result] += 1;
        this.count(retried);
      } catch (e) {
        errors.push(e);
      }
    }
    this.metrics.setPendingReferences(await this.uow.run((r) => r.transactions.countPendingReferences()));
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} of ${candidates.length} pending references failed`, { cause: errors[0] });
    }
    return result;
  }

  private async retry(r: TxRepositories, candidate: { id: string; walletId: string }, now: Date): Promise<Retried | undefined> {
    const wallet = await r.wallets.lockById(candidate.walletId);
    const tx = await r.transactions.lockById(candidate.id);
    if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
    if (tx.nextAttemptAt && tx.nextAttemptAt.getTime() > now.getTime()) return undefined;

    let settlement: SettlementResult = settle({
      tx,
      wallet,
      reference: await lookupReference(r, tx.providerId, tx.referenceExternalTransactionId),
      ledgerEntryId: this.ids.next(),
      now,
      pendingRetryAt: computeNextAttemptAt(now, tx.attempts + 1, this.policy.backoff),
    });
    let result: Retried['result'] = 'resolved';
    if (settlement.outcome === 'PENDING_REFERENCE') {
      // `settle` already counted this attempt (scheduleReferenceRetry).
      if (!this.exhausted(tx, now)) {
        await r.transactions.update(tx);
        return { result: 'rescheduled', tx };
      }
      tx.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
      settlement = { outcome: 'REJECTED', failureCode: FailureCode.ReferenceNotFound };
      result = 'expired';
    }
    await persistSettlement(
      r,
      { tx, wallet, settlement, write: 'update', correlationId: correlationOf(tx), now },
      { ids: this.ids, faults: this.faults },
    );
    return { result, tx };
  }

  private exhausted(tx: WagerTransaction, now: Date): boolean {
    return tx.attempts >= this.policy.maxAttempts || now.getTime() - tx.createdAt.getTime() >= this.policy.ttlMs;
  }

  private count({ result, tx }: Retried): void {
    if (result === 'rescheduled') this.metrics.retry('pending-reference');
    else this.metrics.transaction(tx.status, tx.kind, 'worker');
  }
}
