import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Why the broker refused one message, for logs (never the payload). */
export interface PublishFailure {
  id: string;
  reason: string;
}

export interface EventPublisher {
  publishBatch(messages: OutboxMessage[]): Promise<{ published: string[]; failed: PublishFailure[] }>;
}
