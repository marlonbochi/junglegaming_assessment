import { describe, expect, test } from 'bun:test';
import {
  backoffDelayMs,
  computeNextAttemptAt,
  CONSUMER_BACKOFF,
  OUTBOX_BACKOFF,
  PENDING_REFERENCE_BACKOFF,
} from '../../../src/domain/messaging/backoff';

describe('backoff', () => {
  test('backoff doubles and caps', () => {
    const p = { baseMs: 1000, capMs: 5000, jitter: () => 0 };
    const t0 = new Date(0);
    expect([0, 1, 2, 3, 10].map((a) => computeNextAttemptAt(t0, a, p).getTime())).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });

  test('jitter adds at most 20%', () => {
    expect(backoffDelayMs(0, { baseMs: 1000, capMs: 5000, jitter: () => 0.999 })).toBeLessThan(1200);
    expect(backoffDelayMs(0, { baseMs: 1000, capMs: 5000, jitter: () => 0.5 })).toBe(1100);
  });

  test('policy constants', () => {
    expect(OUTBOX_BACKOFF).toEqual({ baseMs: 1000, capMs: 300_000 });
    expect(PENDING_REFERENCE_BACKOFF).toEqual({ baseMs: 2000, capMs: 60_000 });
    expect(CONSUMER_BACKOFF).toEqual({ baseMs: 1000, capMs: 60_000 });
  });
});
