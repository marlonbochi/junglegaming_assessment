import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics } from '../../application/ports/metrics';

/** Spec §8 metrics on a registry of its own, so several apps can live in one process. */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions decided, by final status, kind and source',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicate submissions, by source and type (replay | inbox)',
    labelNames: ['source', 'type'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled, by component',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  private readonly dlqMessages = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'db_lock_conflicts_total',
    help: 'Lock timeouts and unique-violation re-runs',
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'SubmitWagerTransaction duration, by source',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Wallet reconciliations whose stored balance differs from the ledger',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  private readonly pendingReferences = new Gauge({
    name: 'pending_reference_transactions',
    help: 'Transactions waiting for their reference',
    registers: [this.registry],
  });

  transaction(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicate(source: string, type: string): void {
    this.duplicates.inc({ source, type });
  }

  retry(component: string): void {
    this.retries.inc({ component });
  }

  dlq(reason: string): void {
    this.dlqMessages.inc({ reason });
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  processingDuration(source: string, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  setOutboxPending(n: number): void {
    this.outboxPending.set(n);
  }

  setPendingReferences(n: number): void {
    this.pendingReferences.set(n);
  }
}
