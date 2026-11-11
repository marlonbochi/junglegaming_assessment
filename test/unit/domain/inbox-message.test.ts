import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { now } from '../../support/fixtures';

describe('InboxMessage', () => {
  test('inbox receive is processed', () => {
    const m = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', now });
    expect(m.isProcessed()).toBe(true);
    expect(m.receivedAt).toEqual(now);
    expect(m.processedAt).toEqual(now);
    expect(m.payloadHash).toBe('h');
  });

  test('rehydrated unprocessed message becomes processed via markProcessed', () => {
    const m = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: now });
    expect(m.isProcessed()).toBe(false);
    const later = new Date(now.getTime() + 1000);
    m.markProcessed(later);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(later);
  });
});
