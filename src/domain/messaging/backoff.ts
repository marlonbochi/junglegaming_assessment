export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
  /** Returns a factor in [0, 1). Production: Math.random; tests: () => 0. */
  jitter: () => number;
}

export type BackoffConfig = Omit<BackoffPolicy, 'jitter'>;

export const OUTBOX_BACKOFF: BackoffConfig = { baseMs: 1000, capMs: 300_000 };
export const PENDING_REFERENCE_BACKOFF: BackoffConfig = { baseMs: 2000, capMs: 60_000 };
export const CONSUMER_BACKOFF: BackoffConfig = { baseMs: 1000, capMs: 60_000 };

const JITTER_RATIO = 0.2;

export function backoffDelayMs(attempt: number, p: BackoffPolicy): number {
  const delay = Math.min(p.baseMs * 2 ** attempt, p.capMs);
  return delay + delay * JITTER_RATIO * p.jitter();
}

export function computeNextAttemptAt(now: Date, attempt: number, p: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, p));
}
