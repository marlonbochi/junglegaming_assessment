import { Money } from '../money/money';
import { InvalidMoneyError } from '../money/money.errors';
import { FailureCode } from '../shared/failure-code';
import { InvalidTransactionStateError } from '../shared/invalid-transaction-state.error';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import {
  CreateWagerTransactionProps,
  MissingReferenceError,
  OpeningNotAllowedError,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from './wager-transaction.types';

const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if ((p.kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new OpeningNotAllowedError('OPENING transactions cannot be created from outside');
    }
    const needsReference = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (needsReference && !p.referenceExternalTransactionId) {
      throw new MissingReferenceError(`${p.kind} requires a reference transaction`);
    }
    if (!p.money.isPositive()) {
      throw new InvalidMoneyError(`Transaction amount must be positive: ${p.money.toString()}`);
    }
    return new WagerTransaction({
      id: p.id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      money: p.money,
      referenceExternalTransactionId: p.referenceExternalTransactionId,
      status: Pending,
      attempts: 0,
      createdAt: p.now,
      updatedAt: p.now,
    });
  }

  static createOpening(p: { id: string; walletId: string; playerId: string; money: Money; now: Date }): WagerTransaction {
    return new WagerTransaction({
      id: p.id,
      providerId: 'internal',
      externalTransactionId: p.walletId,
      idempotencyKey: `opening:${p.walletId}`,
      // Internal transaction, never subject to external replay.
      payloadHash: '0'.repeat(64),
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: p.money,
      status: Processed,
      observedBalance: p.money,
      attempts: 0,
      processedAt: p.now,
      createdAt: p.now,
      updatedAt: p.now,
    });
  }

  /** Rebuilds a persisted transaction without validation. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...s });
  }

  get id() { return this.state.id; }
  get providerId() { return this.state.providerId; }
  get externalTransactionId() { return this.state.externalTransactionId; }
  get idempotencyKey() { return this.state.idempotencyKey; }
  get payloadHash() { return this.state.payloadHash; }
  get walletId() { return this.state.walletId; }
  get playerId() { return this.state.playerId; }
  get roundId() { return this.state.roundId; }
  get gameId() { return this.state.gameId; }
  get kind() { return this.state.kind; }
  get money() { return this.state.money; }
  get referenceExternalTransactionId() { return this.state.referenceExternalTransactionId; }
  get referenceTransactionId() { return this.state.referenceTransactionId; }
  get status() { return this.state.status; }
  get failureCode() { return this.state.failureCode; }
  get observedBalance() { return this.state.observedBalance; }
  get attempts() { return this.state.attempts; }
  get nextAttemptAt() { return this.state.nextAttemptAt; }
  get processedAt() { return this.state.processedAt; }
  get createdAt() { return this.state.createdAt; }
  get updatedAt() { return this.state.updatedAt; }

  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertStatus('markProcessed', Pending, PendingReference);
    this.state.status = Processed;
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.observedBalance = observedBalance;
    this.state.processedAt = at;
    this.state.nextAttemptAt = undefined;
    this.state.updatedAt = at;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertStatus('reject', Pending, PendingReference);
    this.state.status = Rejected;
    this.state.failureCode = code;
    this.state.observedBalance = observedBalance;
    this.state.nextAttemptAt = undefined;
    this.state.updatedAt = at;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertStatus('markPendingReference', Pending);
    this.state.status = PendingReference;
    this.state.nextAttemptAt = nextAttemptAt;
    this.state.updatedAt = nextAttemptAt;
  }

  scheduleReferenceRetry(nextAttemptAt: Date): void {
    this.assertStatus('scheduleReferenceRetry', PendingReference);
    this.state.attempts += 1;
    this.state.nextAttemptAt = nextAttemptAt;
    this.state.updatedAt = nextAttemptAt;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertStatus('fail', Pending, PendingReference);
    this.state.status = Failed;
    this.state.failureCode = code;
    this.state.nextAttemptAt = undefined;
    this.state.updatedAt = at;
  }

  isTerminal(): boolean {
    return this.state.status === Processed || this.state.status === Rejected || this.state.status === Failed;
  }

  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.state.kind === WagerTransactionKind.Refund || this.state.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.state.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError('ROLLBACK needs its reference to define a direction');
        const original = reference.ledgerDirectionFor();
        if (!original) throw new InvalidTransactionStateError('Reference transaction has no ledger direction');
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private assertStatus(action: string, ...allowed: WagerTransactionStatus[]): void {
    if (!allowed.includes(this.state.status)) {
      throw new InvalidTransactionStateError(
        `Cannot ${action} transaction ${this.state.id} in status ${this.state.status}`,
      );
    }
  }
}
