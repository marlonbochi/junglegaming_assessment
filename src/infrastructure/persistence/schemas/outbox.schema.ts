import { defineEntity, p } from '@mikro-orm/core';

export const OutboxSchema = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<unknown>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});

export class OutboxRecord extends OutboxSchema.class {}
OutboxSchema.setClass(OutboxRecord);
