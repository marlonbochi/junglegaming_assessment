import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(m: InboxMessage): Promise<void>;
}
