import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError } from '../../../src/domain/money/money.errors';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { InvalidTransactionStateError } from '../../../src/domain/shared/invalid-transaction-state.error';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import {
  MissingReferenceError,
  OpeningNotAllowedError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction.types';
import { bet, brl, now, tx, txProps } from '../../support/fixtures';

const later = new Date('2026-11-11T01:00:00Z');

const argsFor = (method: string): unknown[] => {
  switch (method) {
    case 'markProcessed':
      return ['ref', brl('1.00'), later];
    case 'reject':
      return [FailureCode.InsufficientFunds, brl('1.00'), later];
    case 'fail':
      return [FailureCode.InternalProcessingError, later];
    case 'markPendingReference':
    case 'scheduleReferenceRetry':
      return [later, later];
    default:
      throw new Error(`no args for ${method}`);
  }
};

describe('WagerTransaction', () => {
  test('create starts PENDING with attempts 0', () => {
    const t = bet();
    expect(t.status).toBe(WagerTransactionStatus.Pending);
    expect(t.attempts).toBe(0);
    expect(t.createdAt).toEqual(now);
    expect(t.updatedAt).toEqual(now);
  });

  test.each(['REFUND', 'ROLLBACK'] as const)('%s without reference throws', (k) =>
    expect(() => tx({ kind: k, referenceExternalTransactionId: undefined })).toThrow(MissingReferenceError));

  test('OPENING via create throws', () =>
    expect(() => tx({ kind: 'OPENING' })).toThrow(OpeningNotAllowedError));

  test.each(['0.00', '-1.00'])('create rejects non-positive money %s', (amount) =>
    expect(() => tx({ money: brl(amount) })).toThrow(InvalidMoneyError));

  test('PENDING → PROCESSED sets processedAt, reference and observedBalance', () => {
    const t = bet();
    t.markProcessed('ref-1', brl('20.00'), later);
    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.processedAt).toEqual(later);
    expect(t.updatedAt).toEqual(later);
    expect(t.referenceTransactionId).toBe('ref-1');
    expect(t.observedBalance?.toJSON().amount).toBe('20.00');
  });

  test('reject records code and observedBalance without processedAt', () => {
    const t = bet();
    t.reject(FailureCode.InsufficientFunds, brl('3.00'), later);
    expect(t.status).toBe(WagerTransactionStatus.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.observedBalance?.toJSON().amount).toBe('3.00');
    expect(t.processedAt).toBeUndefined();
    expect(t.updatedAt).toEqual(later);
  });

  test('fail records code without processedAt', () => {
    const t = bet();
    t.fail(FailureCode.InternalProcessingError, later);
    expect(t.status).toBe(WagerTransactionStatus.Failed);
    expect(t.failureCode).toBe(FailureCode.InternalProcessingError);
    expect(t.processedAt).toBeUndefined();
    expect(t.updatedAt).toEqual(later);
  });

  test('PENDING → PENDING_REFERENCE → retry increments attempts → PROCESSED', () => {
    const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'b1' });
    t.markPendingReference(new Date(1), now);
    expect(t.status).toBe(WagerTransactionStatus.PendingReference);
    t.scheduleReferenceRetry(new Date(2), later);
    expect(t.attempts).toBe(1);
    expect(t.nextAttemptAt).toEqual(new Date(2));
    t.markProcessed('ref', brl('1.00'), now);
    expect(t.isTerminal()).toBe(true);
  });

  test('pending reference transitions set updatedAt = at and keep nextAttemptAt as given', () => {
    const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'b1' });
    const next = new Date('2026-11-12T00:00:00Z');
    t.markPendingReference(next, later);
    expect(t.nextAttemptAt).toEqual(next);
    expect(t.updatedAt).toEqual(later);
    const next2 = new Date('2026-11-13T00:00:00Z');
    const at2 = new Date('2026-11-11T02:00:00Z');
    t.scheduleReferenceRetry(next2, at2);
    expect(t.nextAttemptAt).toEqual(next2);
    expect(t.updatedAt).toEqual(at2);
  });

  test.each(['markProcessed', 'reject', 'fail'])('%s clears nextAttemptAt', (m) => {
    const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'b1' });
    t.markPendingReference(later, now);
    expect(t.nextAttemptAt).toEqual(later);
    (t as any)[m](...argsFor(m));
    expect(t.nextAttemptAt).toBeUndefined();
  });

  test.each(['reject', 'fail', 'markProcessed'])('PENDING_REFERENCE → %s allowed', (m) => {
    const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'b1' });
    t.markPendingReference(later, now);
    (t as any)[m](...argsFor(m));
    expect(t.isTerminal()).toBe(true);
  });

  test.each(['markProcessed', 'reject', 'fail', 'markPendingReference', 'scheduleReferenceRetry'])(
    'terminal + %s throws InvalidTransactionStateError',
    (m) => {
      const t = bet();
      t.reject(FailureCode.InsufficientFunds, brl('0.00'), now);
      expect(() => (t as any)[m](...argsFor(m))).toThrow(InvalidTransactionStateError);
    },
  );

  test('markPendingReference only from PENDING', () => {
    const t = bet();
    t.markPendingReference(later, now);
    expect(() => t.markPendingReference(later, now)).toThrow(InvalidTransactionStateError);
  });

  test('scheduleReferenceRetry from PENDING throws', () =>
    expect(() => bet().scheduleReferenceRetry(later, now)).toThrow(InvalidTransactionStateError));

  test('isTerminal false for PENDING and PENDING_REFERENCE', () => {
    const t = bet();
    expect(t.isTerminal()).toBe(false);
    t.markPendingReference(later, now);
    expect(t.isTerminal()).toBe(false);
  });

  test('affectsBalance false only for LOSS', () => {
    expect(tx({ kind: 'LOSS' }).affectsBalance()).toBe(false);
    expect(bet().affectsBalance()).toBe(true);
  });

  test('requiresReference true only for REFUND and ROLLBACK', () => {
    expect(tx({ kind: 'REFUND', referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(bet().requiresReference()).toBe(false);
    expect(tx({ kind: 'WIN' }).requiresReference()).toBe(false);
  });

  test('ledgerDirectionFor', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: 'WIN' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: 'REFUND', referenceExternalTransactionId: 'x' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: 'LOSS' }).ledgerDirectionFor()).toBeUndefined();
    const rb = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(tx({ kind: 'WIN' }))).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK ledgerDirectionFor without reference throws', () => {
    const rb = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload', () => {
    const t = bet({ payloadHash: 'a'.repeat(64) });
    expect(t.matchesPayload('a'.repeat(64))).toBe(true);
    expect(t.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('createOpening is PROCESSED with internal provider', () => {
    const o = WagerTransaction.createOpening({ id: 't0', walletId: 'w1', playerId: 'p1', money: brl('100.00'), now });
    expect(o.status).toBe(WagerTransactionStatus.Processed);
    expect(o.kind).toBe(WagerTransactionKind.Opening);
    expect(o.providerId).toBe('internal');
    expect(o.externalTransactionId).toBe('w1');
    expect(o.idempotencyKey).toBe('opening:w1');
    expect(o.payloadHash).toBe('0'.repeat(64));
    expect(o.roundId).toBeUndefined();
    expect(o.gameId).toBeUndefined();
    expect(o.processedAt).toEqual(now);
    expect(o.observedBalance?.toJSON().amount).toBe('100.00');
    expect(o.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('rehydrate round-trips through toState without validating', () => {
    const t = bet();
    t.markProcessed('ref', brl('5.00'), later);
    const copy = WagerTransaction.rehydrate(t.toState());
    expect(copy.toState()).toEqual(t.toState());
    expect(copy.status).toBe(WagerTransactionStatus.Processed);
    const zero = WagerTransaction.rehydrate({ ...t.toState(), money: brl('0.00') });
    expect(zero.money.isZero()).toBe(true);
  });

  test('txProps generates unique ids', () => {
    expect(txProps().id).not.toBe(txProps().id);
  });
});
