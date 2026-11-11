import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  enqueue(m: OutboxMessage): Promise<void>;
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(m: OutboxMessage): Promise<void>;
  lagSeconds(now: Date): Promise<number>;
  pendingCount(): Promise<number>;
}
