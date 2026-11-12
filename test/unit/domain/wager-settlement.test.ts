import { describe, expect, test } from 'bun:test';
import { Money, MONEY_MAX_MINOR_UNITS } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { InvalidTransactionStateError } from '../../../src/domain/shared/invalid-transaction-state.error';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { ReferenceLookup, settle } from '../../../src/domain/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction.types';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { bet, brl, now, tx, TxOverrides } from '../../support/fixtures';

const pendingRetryAt = new Date('2026-11-11T00:00:02Z');

const NONE: ReferenceLookup = { kind: 'none' };
const MISSING: ReferenceLookup = { kind: 'missing' };

function run(t: WagerTransaction, walletBalance: string | Money, reference: ReferenceLookup = NONE) {
  const wallet = Wallet.rehydrate({
    id: 'w1',
    playerId: 'p1',
    currency: 'BRL',
    balance: typeof walletBalance === 'string' ? brl(walletBalance) : walletBalance,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const result = settle({ tx: t, wallet, reference, ledgerEntryId: 'entry-1', now, pendingRetryAt });
  return { result, tx: t, wallet };
}

const processed = (t: WagerTransaction): WagerTransaction => {
  t.markProcessed(undefined, brl('0.00'), now);
  return t;
};

const found = (t: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  kind: 'found',
  transaction: t,
  alreadyReversed,
});

const dependent = (kind: TxOverrides['kind'], overrides: TxOverrides = {}): WagerTransaction =>
  tx({ kind, referenceExternalTransactionId: 'ext-ref', ...overrides });

const expectRejected = (r: ReturnType<typeof run>, code: FailureCode, observed: string) => {
  expect(r.result).toEqual({ outcome: 'REJECTED', failureCode: code });
  expect(r.tx.status).toBe(WagerTransactionStatus.Rejected);
  expect(r.tx.failureCode).toBe(code);
  expect(r.tx.observedBalance?.toJSON().amount).toBe(observed);
  expect(r.wallet.balance.toJSON().amount).toBe(observed);
  expect(r.wallet.version).toBe(1);
};

const entryOf = (r: ReturnType<typeof run>) => {
  if (r.result.outcome !== 'PROCESSED' || !r.result.ledgerEntry) throw new Error('expected a ledger entry');
  return r.result.ledgerEntry;
};

describe('settle', () => {
  test('BET with funds → PROCESSED, DEBIT entry, balance 20.00', () => {
    const r = run(bet(), '45.00');
    expect(r.result.outcome).toBe('PROCESSED');
    const entry = entryOf(r);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.id).toBe('entry-1');
    expect(entry.transactionId).toBe(r.tx.id);
    expect(entry.createdAt).toEqual(now);
    expect(r.wallet.balance.toJSON().amount).toBe('20.00');
    expect(r.wallet.version).toBe(2);
    expect(r.tx.status).toBe(WagerTransactionStatus.Processed);
    expect(r.tx.observedBalance?.toJSON().amount).toBe('20.00');
    expect(r.tx.referenceTransactionId).toBeUndefined();
    expect(r.tx.processedAt).toEqual(now);
  });

  test('BET without funds → REJECTED INSUFFICIENT_FUNDS, no entry, version unchanged, observedBalance 20.00', () => {
    const r = run(bet(), '20.00');
    expectRejected(r, FailureCode.InsufficientFunds, '20.00');
    expect(r.tx.updatedAt).toEqual(now);
  });

  test('WIN without reference → PROCESSED CREDIT', () => {
    const r = run(tx({ kind: 'WIN' }), '10.00');
    expect(r.result.outcome).toBe('PROCESSED');
    expect(entryOf(r).direction).toBe(LedgerDirection.Credit);
    expect(r.wallet.balance.toJSON().amount).toBe('35.00');
    expect(r.tx.observedBalance?.toJSON().amount).toBe('35.00');
    expect(r.tx.referenceTransactionId).toBeUndefined();
  });

  test('WIN with reference to PROCESSED BET of the same round → PROCESSED, links reference', () => {
    const b = processed(bet());
    const r = run(dependent('WIN', { money: brl('50.00') }), '10.00', found(b));
    expect(r.result.outcome).toBe('PROCESSED');
    expect(entryOf(r).direction).toBe(LedgerDirection.Credit);
    expect(r.tx.referenceTransactionId).toBe(b.id);
    expect(r.wallet.balance.toJSON().amount).toBe('60.00');
  });

  test('WIN referencing an already reversed BET → PROCESSED (reversal check only for REFUND/ROLLBACK)', () => {
    const b = processed(bet());
    const r = run(dependent('WIN'), '10.00', found(b, true));
    expect(r.result.outcome).toBe('PROCESSED');
    expect(r.tx.referenceTransactionId).toBe(b.id);
  });

  test('WIN with reference to BET in another round → REJECTED REFERENCE_MISMATCH', () => {
    const b = processed(bet({ roundId: 'round-2' }));
    expectRejected(run(dependent('WIN'), '10.00', found(b)), FailureCode.ReferenceMismatch, '10.00');
  });

  test('LOSS → PROCESSED, no entry, version unchanged', () => {
    const r = run(tx({ kind: 'LOSS' }), '10.00');
    expect(r.result).toEqual({ outcome: 'PROCESSED' });
    expect(r.wallet.version).toBe(1);
    expect(r.wallet.balance.toJSON().amount).toBe('10.00');
    expect(r.tx.status).toBe(WagerTransactionStatus.Processed);
    expect(r.tx.observedBalance?.toJSON().amount).toBe('10.00');
  });

  test('REFUND of PROCESSED BET → PROCESSED CREDIT, tx.referenceTransactionId = bet.id', () => {
    const b = processed(bet());
    const r = run(dependent('REFUND'), '10.00', found(b));
    expect(r.result.outcome).toBe('PROCESSED');
    expect(entryOf(r).direction).toBe(LedgerDirection.Credit);
    expect(r.tx.referenceTransactionId).toBe(b.id);
    expect(r.wallet.balance.toJSON().amount).toBe('35.00');
  });

  test('REFUND referencing WIN → REJECTED REFERENCE_KIND_NOT_ALLOWED', () => {
    const w = processed(tx({ kind: 'WIN' }));
    expectRejected(run(dependent('REFUND'), '10.00', found(w)), FailureCode.ReferenceKindNotAllowed, '10.00');
  });

  test('REFUND with different amount → REJECTED REFERENCE_AMOUNT_MISMATCH', () => {
    const b = processed(bet({ money: brl('30.00') }));
    expectRejected(run(dependent('REFUND'), '10.00', found(b)), FailureCode.ReferenceAmountMismatch, '10.00');
  });

  test('REFUND of already reversed BET → REJECTED REFERENCE_ALREADY_REVERSED', () => {
    const b = processed(bet());
    expectRejected(run(dependent('REFUND'), '10.00', found(b, true)), FailureCode.ReferenceAlreadyReversed, '10.00');
  });

  test('ROLLBACK of BET → CREDIT; of WIN → DEBIT; of REFUND → DEBIT', () => {
    const cases = [
      { reference: processed(bet()), direction: LedgerDirection.Credit, after: '125.00' },
      { reference: processed(tx({ kind: 'WIN' })), direction: LedgerDirection.Debit, after: '75.00' },
      {
        reference: processed(tx({ kind: 'REFUND', referenceExternalTransactionId: 'ext-bet' })),
        direction: LedgerDirection.Debit,
        after: '75.00',
      },
    ];
    for (const c of cases) {
      const r = run(dependent('ROLLBACK'), '100.00', found(c.reference));
      expect(r.result.outcome).toBe('PROCESSED');
      expect(entryOf(r).direction).toBe(c.direction);
      expect(r.wallet.balance.toJSON().amount).toBe(c.after);
      expect(r.tx.referenceTransactionId).toBe(c.reference.id);
      expect(r.tx.observedBalance?.toJSON().amount).toBe(c.after);
    }
  });

  test('ROLLBACK with different amount → REJECTED REFERENCE_AMOUNT_MISMATCH', () => {
    const b = processed(bet({ money: brl('30.00') }));
    expectRejected(run(dependent('ROLLBACK'), '10.00', found(b)), FailureCode.ReferenceAmountMismatch, '10.00');
  });

  test('ROLLBACK of already reversed BET → REJECTED REFERENCE_ALREADY_REVERSED', () => {
    const b = processed(bet());
    expectRejected(run(dependent('ROLLBACK'), '10.00', found(b, true)), FailureCode.ReferenceAlreadyReversed, '10.00');
  });

  test('ROLLBACK of WIN without funds → REJECTED REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const w = processed(tx({ kind: 'WIN' }));
    expectRejected(run(dependent('ROLLBACK'), '10.00', found(w)), FailureCode.ReversalInsufficientFunds, '10.00');
  });

  test('ROLLBACK of LOSS → REJECTED REFERENCE_KIND_NOT_ALLOWED', () => {
    const l = processed(tx({ kind: 'LOSS' }));
    expectRejected(run(dependent('ROLLBACK'), '10.00', found(l)), FailureCode.ReferenceKindNotAllowed, '10.00');
  });

  test('reference missing → PENDING_REFERENCE with nextAttemptAt = pendingRetryAt', () => {
    const r = run(dependent('REFUND'), '10.00', MISSING);
    expect(r.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(r.tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(r.tx.nextAttemptAt).toEqual(pendingRetryAt);
    expect(r.tx.attempts).toBe(0);
    expect(r.tx.updatedAt).toEqual(now);
    expect(r.wallet.version).toBe(1);
  });

  test.each(['WIN', 'LOSS'] as const)('%s with a missing reference → PENDING_REFERENCE, no entry, balance unchanged', (kind) => {
    const r = run(dependent(kind), '10.00', MISSING);
    expect(r.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(r.tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(r.tx.nextAttemptAt).toEqual(pendingRetryAt);
    expect(r.tx.observedBalance).toBeUndefined();
    expect(r.wallet.balance.toJSON().amount).toBe('10.00');
    expect(r.wallet.version).toBe(1);
  });

  test('reference missing while tx already PENDING_REFERENCE → stays, attempts + 1', () => {
    const t = dependent('REFUND');
    t.markPendingReference(now, now);
    const r = run(t, '10.00', MISSING);
    expect(r.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(r.tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(r.tx.attempts).toBe(1);
    expect(r.tx.nextAttemptAt).toEqual(pendingRetryAt);
    expect(r.wallet.version).toBe(1);
  });

  test('reference PENDING_REFERENCE → PENDING_REFERENCE', () => {
    const ref = dependent('REFUND');
    ref.markPendingReference(now, now);
    const r = run(dependent('ROLLBACK'), '10.00', found(ref));
    expect(r.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(r.tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(r.wallet.version).toBe(1);
  });

  test('reference PENDING → PENDING_REFERENCE', () => {
    const r = run(dependent('REFUND'), '10.00', found(bet()));
    expect(r.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(r.wallet.version).toBe(1);
  });

  test('reference REJECTED → REJECTED REFERENCE_NOT_REVERSIBLE', () => {
    const b = bet();
    b.reject(FailureCode.InsufficientFunds, brl('0.00'), now);
    expectRejected(run(dependent('REFUND'), '10.00', found(b)), FailureCode.ReferenceNotReversible, '10.00');
  });

  test('reference FAILED → REJECTED REFERENCE_NOT_REVERSIBLE', () => {
    const b = bet();
    b.fail(FailureCode.InternalProcessingError, now);
    expectRejected(run(dependent('REFUND'), '10.00', found(b)), FailureCode.ReferenceNotReversible, '10.00');
  });

  test.each(['providerId', 'playerId', 'walletId', 'roundId'] as const)(
    'reference with different %s → REFERENCE_MISMATCH',
    (field) => {
      const b = processed(bet({ [field]: 'other' }));
      expectRejected(run(dependent('REFUND'), '10.00', found(b)), FailureCode.ReferenceMismatch, '10.00');
    },
  );

  test('reference with different currency → REFERENCE_MISMATCH (before amount check)', () => {
    const b = processed(bet({ money: Money.from({ amount: '25.00', currency: 'USD' }) }));
    expectRejected(run(dependent('REFUND'), '10.00', found(b)), FailureCode.ReferenceMismatch, '10.00');
  });

  test('player not owner → PLAYER_WALLET_MISMATCH (before reference checks)', () => {
    const r = run(dependent('REFUND', { playerId: 'p2' }), '10.00', MISSING);
    expectRejected(r, FailureCode.PlayerWalletMismatch, '10.00');
  });

  test('wallet id differs → PLAYER_WALLET_MISMATCH', () => {
    expectRejected(run(bet({ walletId: 'w2' }), '100.00'), FailureCode.PlayerWalletMismatch, '100.00');
  });

  test('currency ≠ wallet currency → CURRENCY_MISMATCH', () => {
    const r = run(bet({ money: Money.from({ amount: '5.00', currency: 'USD' }) }), '100.00');
    expectRejected(r, FailureCode.CurrencyMismatch, '100.00');
  });

  test('WIN that overflows storage → REJECTED BALANCE_LIMIT_EXCEEDED', () => {
    const max = Money.fromMinorUnits(MONEY_MAX_MINOR_UNITS, 'BRL');
    const r = run(tx({ kind: 'WIN' }), max);
    expect(r.result).toEqual({ outcome: 'REJECTED', failureCode: FailureCode.BalanceLimitExceeded });
    expect(r.tx.observedBalance?.equals(max)).toBe(true);
    expect(r.wallet.balance.equals(max)).toBe(true);
    expect(r.wallet.version).toBe(1);
  });

  test('REFUND without a reference lookup is a programming error', () => {
    expect(() => run(dependent('REFUND'), '10.00', NONE)).toThrow(InvalidTransactionStateError);
  });
});
