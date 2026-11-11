import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher } from '../ports/event-publisher';
import type { FaultInjector } from '../ports/fault-injector';
import type { Metrics } from '../ports/metrics';
import type { TxRepositories, UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxResult {
  published: number;
  retried: number;
}

/**
 * Spec §6.5, one batch: lock due messages (`SKIP LOCKED`, so concurrent publishers get disjoint
 * batches), publish, then mark each one published or schedule its retry — all in one SQL transaction.
 * The lock is held during the SQS call; if the process dies the lock is released and another publisher
 * sends the batch again, which the consumer deduplicates by `eventId`.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly jitter: () => number,
  ) {}

  async execute(batchSize: number): Promise<PublishOutboxResult> {
    const now = this.clock.now();
    let locked = 0;
    try {
      const { result, lag, pending } = await this.uow.run(async (r) => {
        const batch = await r.outbox.lockDueBatch(now, batchSize);
        locked = batch.length;
        const outcome = await this.publish(r, batch, now);
        return { result: outcome, lag: await r.outbox.lagSeconds(now), pending: await r.outbox.pendingCount() };
      });
      this.metrics.setOutboxLag(lag);
      this.metrics.setOutboxPending(pending);
      this.countRetries(result.retried);
      return result;
    } catch (e) {
      // Rolled back: the locked messages stay due and the next run publishes them again.
      this.countRetries(locked);
      throw e;
    }
  }

  private async publish(r: TxRepositories, batch: OutboxMessage[], now: Date): Promise<PublishOutboxResult> {
    if (batch.length === 0) return { published: 0, retried: 0 };
    const published = new Set((await this.publisher.publishBatch(batch)).published);
    this.faults.hit('after_publish_before_mark');
    for (const m of batch) {
      // Anything not confirmed as published is retried.
      if (published.has(m.id)) m.markPublished(now);
      else m.scheduleRetry(now, this.jitter);
      await r.outbox.save(m);
    }
    const count = batch.filter((m) => published.has(m.id)).length;
    return { published: count, retried: batch.length - count };
  }

  private countRetries(n: number): void {
    for (let i = 0; i < n; i++) this.metrics.retry('outbox');
  }
}
