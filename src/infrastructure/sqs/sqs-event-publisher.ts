import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** SQS limit of entries per SendMessageBatch. */
const MAX_BATCH_ENTRIES = 10;

/**
 * Spec §6.5: publishes outbox messages to `wallet-events.fifo` (`MessageGroupId = aggregateId`,
 * `MessageDeduplicationId = eventId`). A chunk SQS refuses as a whole counts as failed, so the other
 * chunks keep their outcome and the caller schedules a retry instead of republishing everything.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> {
    const published: string[] = [];
    const failed: string[] = [];
    for (let start = 0; start < messages.length; start += MAX_BATCH_ENTRIES) {
      const chunk = messages.slice(start, start + MAX_BATCH_ENTRIES);
      const outcome = await this.send(chunk);
      published.push(...outcome.published);
      failed.push(...outcome.failed);
    }
    return { published, failed };
  }

  private async send(chunk: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> {
    try {
      const { Successful = [] } = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((m, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId,
            MessageDeduplicationId: m.id,
          })),
        }),
      );
      // Entry ids are chunk indexes. Anything not reported as successful (listed in `Failed` or not
      // answered at all) is failed, never published.
      const ok = new Set(Successful.map((e) => Number(e.Id)));
      return {
        published: chunk.filter((_, index) => ok.has(index)).map((m) => m.id),
        failed: chunk.filter((_, index) => !ok.has(index)).map((m) => m.id),
      };
    } catch {
      return { published: [], failed: chunk.map((m) => m.id) };
    }
  }
}
