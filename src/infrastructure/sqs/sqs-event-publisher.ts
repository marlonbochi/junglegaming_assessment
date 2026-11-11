import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailure } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** SQS limit of entries per SendMessageBatch. */
const MAX_BATCH_ENTRIES = 10;

interface PublishOutcome {
  published: string[];
  failed: PublishFailure[];
}

/**
 * Spec §6.5: publishes outbox messages to `wallet-events.fifo` (`MessageGroupId = aggregateId`,
 * `MessageDeduplicationId = eventId`). A chunk SQS refuses as a whole counts as failed with the error as
 * reason, so the other chunks keep their outcome and the caller schedules a retry.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: OutboxMessage[]): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { published: [], failed: [] };
    for (let start = 0; start < messages.length; start += MAX_BATCH_ENTRIES) {
      const chunk = await this.send(messages.slice(start, start + MAX_BATCH_ENTRIES));
      outcome.published.push(...chunk.published);
      outcome.failed.push(...chunk.failed);
    }
    return outcome;
  }

  private async send(chunk: OutboxMessage[]): Promise<PublishOutcome> {
    let response;
    try {
      response = await this.sqs.send(
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
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { published: [], failed: chunk.map((m) => ({ id: m.id, reason })) };
    }
    // Entry ids are chunk indexes. Anything not reported as successful is failed, never published.
    const ok = new Set((response.Successful ?? []).map((e) => Number(e.Id)));
    const refused = new Map((response.Failed ?? []).map((e) => [Number(e.Id), `${e.Code}: ${e.Message}`]));
    return {
      published: chunk.filter((_, index) => ok.has(index)).map((m) => m.id),
      failed: chunk
        .map((m, index) => ({ m, index }))
        .filter(({ index }) => !ok.has(index))
        .map(({ m, index }) => ({ id: m.id, reason: refused.get(index) ?? 'not acknowledged by SQS' })),
    };
  }
}
