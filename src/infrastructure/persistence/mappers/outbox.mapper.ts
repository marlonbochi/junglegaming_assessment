import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { OutboxRecord } from '../schemas/outbox.schema';

export function outboxToDomain(r: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
  });
}

export function outboxToRecord(m: OutboxMessage): OutboxRecord {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: m.payload,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt ?? null,
    publishedAt: m.publishedAt ?? null,
  };
}
