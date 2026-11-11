import { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { InboxRecord } from '../schemas/inbox.schema';

export function inboxToDomain(r: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt ?? undefined,
  });
}

export function inboxToRecord(m: InboxMessage): InboxRecord {
  return {
    consumerName: m.consumerName,
    messageId: m.messageId,
    payloadHash: m.payloadHash,
    receivedAt: m.receivedAt,
    processedAt: m.processedAt ?? null,
  };
}
