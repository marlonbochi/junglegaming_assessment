import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { outboxToDomain, outboxToRecord } from '../mappers/outbox.mapper';
import { OutboxSchema } from '../schemas/outbox.schema';
import { assertSingleRow } from './read-options';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(m: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxSchema, outboxToRecord(m));
  }

  /** Concurrent publishers get disjoint batches: rows locked by another transaction are skipped. */
  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute(
      `SELECT * FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY occurred_at, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((row) => outboxToDomain(this.em.map(OutboxSchema, row)));
  }

  async save(m: OutboxMessage): Promise<void> {
    const { id, ...changes } = outboxToRecord(m);
    assertSingleRow(await this.em.nativeUpdate(OutboxSchema, { id }, changes), `outbox message ${id}`);
  }

  async lagSeconds(now: Date): Promise<number> {
    const [row] = await this.em.execute<Array<{ lag: number | null }>>(
      `SELECT extract(epoch FROM (?::timestamptz - min(occurred_at)))::float8 AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    return Math.max(0, row?.lag ?? 0);
  }

  pendingCount(): Promise<number> {
    return this.em.count(OutboxSchema, { publishedAt: null });
  }
}
