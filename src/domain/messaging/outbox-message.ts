import type { IntegrationEvent } from '../events/integration-event';
import { InvalidTransactionStateError } from '../shared/invalid-transaction-state.error';
import { computeNextAttemptAt, OUTBOX_BACKOFF } from './backoff';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...s });
  }

  get id() { return this.state.id; }
  get aggregateId() { return this.state.aggregateId; }
  get eventType() { return this.state.eventType; }
  get payload() { return this.state.payload; }
  get occurredAt() { return this.state.occurredAt; }
  get attempts() { return this.state.attempts; }
  get nextAttemptAt() { return this.state.nextAttemptAt; }
  get publishedAt() { return this.state.publishedAt; }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt !== undefined && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`Outbox message ${this.id} is already published`);
    this.state.publishedAt = at;
    this.state.nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date, jitter: () => number = Math.random): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`Outbox message ${this.id} is already published`);
    this.state.attempts += 1;
    this.state.nextAttemptAt = computeNextAttemptAt(now, this.state.attempts, { ...OUTBOX_BACKOFF, jitter });
  }
}
