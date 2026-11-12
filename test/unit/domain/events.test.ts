import { describe, expect, test } from 'bun:test';
import { EventContext } from '../../../src/domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { InvalidTransactionStateError } from '../../../src/domain/shared/invalid-transaction-state.error';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { bet, brl, now, tx } from '../../support/fixtures';

const ctx: EventContext = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  occurredAt: new Date('2026-11-11T10:00:00Z'),
};

function walletAndEntry() {
  const wallet = Wallet.rehydrate({
    id: 'w1', playerId: 'p1', currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: now, updatedAt: now,
  });
  const entry = wallet.debit({ money: brl('20.00'), transactionId: 'tx-9', entryId: 'entry-1', now });
  return { wallet, entry };
}

describe('integration events', () => {
  test('WalletBalanceChanged envelope', () => {
    const { wallet, entry } = walletAndEntry();
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      occurredAt: ctx.occurredAt.toISOString(),
    });
    expect(json.data.money).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('causationId defaults to the transaction id and is omitted from JSON when absent from props', () => {
    const { wallet, entry } = walletAndEntry();
    expect(WalletBalanceChanged.from(wallet, entry, ctx).toJSON().causationId).toBe('tx-9');
  });

  test('Processed carries transaction data, balance and causationId = transaction id', () => {
    const t = bet();
    t.markProcessed(undefined, brl('75.00'), now);
    const json = WagerTransactionProcessed.from(t, brl('75.00'), ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe(t.walletId);
    expect(json.causationId).toBe(t.id);
    expect(json.data).toMatchObject({
      transactionId: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'round-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect('referenceTransactionId' in json.data).toBe(false);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('Processed includes referenceTransactionId when set', () => {
    const t = tx({ kind: 'WIN', referenceExternalTransactionId: 'ext-ref' });
    t.markProcessed('tx-ref', brl('10.00'), now);
    expect(WagerTransactionProcessed.from(t, brl('10.00'), ctx).data.referenceTransactionId).toBe('tx-ref');
  });

  test('Rejected adds failureCode', () => {
    const t = bet();
    t.reject(FailureCode.InsufficientFunds, brl('5.00'), now);
    const json = WagerTransactionRejected.from(t, brl('5.00'), ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(json.data.balance).toEqual({ amount: '5.00', currency: 'BRL' });
  });

  test('PendingReference carries reference and nextAttemptAt as ISO string', () => {
    const t = tx({ kind: 'WIN', referenceExternalTransactionId: 'ext-ref' });
    const next = new Date('2026-11-11T00:00:02Z');
    t.markPendingReference(next, now);
    const json = WagerTransactionPendingReference.from(t, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data).toEqual({
      transactionId: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: 'w1',
      kind: 'WIN',
      referenceExternalTransactionId: 'ext-ref',
      nextAttemptAt: next.toISOString(),
    });
  });

  test('PendingReference without nextAttemptAt throws', () => {
    const t = tx({ kind: 'WIN', referenceExternalTransactionId: 'ext-ref' });
    expect(() => WagerTransactionPendingReference.from(t, ctx)).toThrow(InvalidTransactionStateError);
  });

  test('each event subclass has eventType and version on the type', () => {
    const { wallet, entry } = walletAndEntry();
    const processed = bet();
    processed.markProcessed(undefined, brl('1.00'), now);
    const rejected = bet();
    rejected.reject(FailureCode.InsufficientFunds, brl('1.00'), now);
    const pending = tx({ kind: 'WIN', referenceExternalTransactionId: 'r' });
    pending.markPendingReference(now, now);
    const events = [
      WagerTransactionProcessed.from(processed, brl('1.00'), ctx),
      WagerTransactionRejected.from(rejected, brl('1.00'), ctx),
      WagerTransactionPendingReference.from(pending, ctx),
      WalletBalanceChanged.from(wallet, entry, ctx),
    ];
    expect(events.map((e) => [e.eventType, e.version, e.toJSON().eventType, e.toJSON().version])).toEqual([
      ['WagerTransactionProcessed', 1, 'WagerTransactionProcessed', 1],
      ['WagerTransactionRejected', 1, 'WagerTransactionRejected', 1],
      ['WagerTransactionPendingReference', 1, 'WagerTransactionPendingReference', 1],
      ['WalletBalanceChanged', 1, 'WalletBalanceChanged', 1],
    ]);
  });
});
