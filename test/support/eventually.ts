export interface EventuallyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Re-runs `fn` until it resolves without throwing; rethrows the last error on timeout. */
export async function eventually<T>(fn: () => Promise<T>, opts: EventuallyOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 100 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
