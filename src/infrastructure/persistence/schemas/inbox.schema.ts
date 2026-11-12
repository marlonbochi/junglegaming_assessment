import { defineEntity, p } from '@mikro-orm/core';

export const InboxSchema = defineEntity({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export class InboxRecord extends InboxSchema.class {}
InboxSchema.setClass(InboxRecord);
