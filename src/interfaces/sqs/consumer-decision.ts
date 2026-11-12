import { ApplicationError, PermanentInfraError } from '../../application/errors';
import { backoffDelayMs, CONSUMER_BACKOFF } from '../../domain/messaging/backoff';
import { FailureCode } from '../../domain/shared/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.types';

export type ConsumerDecision =
  | { action: 'ack' }
  | { action: 'dlq'; reason: string }
  | { action: 'retry'; delaySeconds: number };

/** `status` is the submission result's status; a FAILED one is a replay of an earlier internal failure. */
export type ProcessingOutcome = { ok: true; status?: WagerTransactionStatus } | { ok: false; error: unknown };

/** SQS upper bound for ChangeMessageVisibility (12 hours). */
export const MAX_VISIBILITY_TIMEOUT_S = 43_200;

/**
 * Spec §6.3: business outcomes are acked; permanent errors go to the DLQ; anything else is retried
 * with exponential backoff by delivery (`receiveCount` 1 → base delay) until the redrive policy takes it.
 * A replayed FAILED transaction is dead-lettered again: the delivery that recorded FAILED may have died
 * before its DLQ send (send failure, crash), and acking the replay would drop the message from both queues.
 * If the earlier send did land, the DLQ deduplication id absorbs the repeat within SQS's 5-minute window;
 * after it the DLQ holds a visible duplicate, never a lost message.
 */
export function decide(outcome: ProcessingOutcome, receiveCount: number, jitter: () => number): ConsumerDecision {
  if (outcome.ok) {
    return outcome.status === WagerTransactionStatus.Failed
      ? { action: 'dlq', reason: FailureCode.InternalProcessingError }
      : { action: 'ack' };
  }
  const { error } = outcome;
  if (error instanceof ApplicationError) return { action: 'dlq', reason: error.code };
  if (error instanceof PermanentInfraError) return { action: 'dlq', reason: FailureCode.InternalProcessingError };
  const delayMs = backoffDelayMs(Math.max(receiveCount - 1, 0), { ...CONSUMER_BACKOFF, jitter });
  return { action: 'retry', delaySeconds: Math.min(Math.ceil(delayMs / 1000), MAX_VISIBILITY_TIMEOUT_S) };
}
