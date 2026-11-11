import { ApplicationError, PermanentInfraError } from '../../application/errors';
import { backoffDelayMs, CONSUMER_BACKOFF } from '../../domain/messaging/backoff';
import { FailureCode } from '../../domain/shared/failure-code';

export type ConsumerDecision =
  | { action: 'ack' }
  | { action: 'dlq'; reason: string }
  | { action: 'retry'; delaySeconds: number };

export type ProcessingOutcome = { ok: true } | { ok: false; error: unknown };

/** SQS upper bound for ChangeMessageVisibility (12 hours). */
export const MAX_VISIBILITY_TIMEOUT_S = 43_200;

/**
 * Spec §6.3: business outcomes are acked; permanent errors go to the DLQ; anything else is retried
 * with exponential backoff by delivery (`receiveCount` 1 → base delay) until the redrive policy takes it.
 */
export function decide(outcome: ProcessingOutcome, receiveCount: number, jitter: () => number): ConsumerDecision {
  if (outcome.ok) return { action: 'ack' };
  const { error } = outcome;
  if (error instanceof ApplicationError) return { action: 'dlq', reason: error.code };
  if (error instanceof PermanentInfraError) return { action: 'dlq', reason: FailureCode.InternalProcessingError };
  const delayMs = backoffDelayMs(Math.max(receiveCount - 1, 0), { ...CONSUMER_BACKOFF, jitter });
  return { action: 'retry', delaySeconds: Math.min(Math.ceil(delayMs / 1000), MAX_VISIBILITY_TIMEOUT_S) };
}
