import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface EventPublisher {
  publishBatch(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }>;
}
