import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import { inboxToDomain, inboxToRecord } from '../mappers/inbox.mapper';
import { InboxSchema } from '../schemas/inbox.schema';
import { FRESH } from './read-options';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxSchema, { consumerName, messageId }, FRESH);
    return r ? inboxToDomain(r) : undefined;
  }

  async insert(m: InboxMessage): Promise<void> {
    await this.em.insert(InboxSchema, inboxToRecord(m));
  }
}
