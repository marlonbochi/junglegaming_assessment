import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../../src/domain/shared/invalid-transaction-state.error';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { brl, now } from '../../support/fixtures';

function event() {
  const wallet = Wallet.rehydrate({
    id: 'w1', playerId: 'p1', currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: now, updatedAt: now,
  });
  const entry = wallet.debit({ money: brl('20.00'), transactionId: 'tx-1', entryId: 'e-1', now });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'evt-1', correlationId: 'c', occurredAt: new Date('2026-11-11T10:00:00Z'),
  });
}

describe('OutboxMessage', () => {
  test('enqueue copies the event envelope and is due at occurredAt', () => {
    const evt = event();
    const m = OutboxMessage.enqueue(evt);
    expect(m.id).toBe('evt-1');
    expect(m.aggregateId).toBe('w1');
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.payload).toEqual(evt.toJSON());
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(new Date('2026-11-11T09:59:59Z'))).toBe(false);
    expect(m.isDue(evt.occurredAt)).toBe(true);
  });

  test('outbox scheduleRetry increments attempts and moves nextAttemptAt', () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(new Date(0), () => 0);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt?.getTime()).toBe(2000);
    expect(m.isDue(new Date(1999))).toBe(false);
    expect(m.isDue(new Date(2000))).toBe(true);
  });

  test('outbox markPublished → not pending; markPublished twice throws', () => {
    const m = OutboxMessage.enqueue(event());
    const at = new Date('2026-11-11T11:00:00Z');
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(m.publishedAt).toEqual(at);
    expect(m.isDue(new Date('2030-01-01'))).toBe(false);
    expect(() => m.markPublished(at)).toThrow(InvalidTransactionStateError);
  });

  test('scheduleRetry on a published message throws', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(now);
    expect(() => m.scheduleRetry(now, () => 0)).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate preserves state', () => {
    const m = OutboxMessage.enqueue(event());
    const copy = OutboxMessage.rehydrate({
      id: m.id, aggregateId: m.aggregateId, eventType: m.eventType, payload: m.payload,
      occurredAt: m.occurredAt, attempts: 3, nextAttemptAt: new Date(5), publishedAt: undefined,
    });
    expect(copy.attempts).toBe(3);
    expect(copy.nextAttemptAt?.getTime()).toBe(5);
  });
});
