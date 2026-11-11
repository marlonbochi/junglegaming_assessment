import type { AppLogger } from '../../application/ports/logger';
import { backoffDelayMs } from '../../domain/messaging/backoff';

/** Returns true when the iteration found work, so the loop runs again without waiting. */
export type Iteration = () => Promise<boolean>;

export interface PollingLoopConfig {
  name: string;
  /** Wait between iterations that found nothing to do. */
  pollMs: number;
}

/** Ceiling of the wait after consecutive failed iterations. */
const MAX_ERROR_BACKOFF_MS = 30_000;

/**
 * Runs `iteration` until stopped: immediately again while there is work, after `pollMs` when idle and
 * with exponential backoff after errors, which are logged and never end the loop.
 */
export class PollingLoop {
  private readonly abort = new AbortController();
  private loop?: Promise<void>;

  constructor(
    private readonly iteration: Iteration,
    private readonly logger: AppLogger,
    private readonly jitter: () => number,
    private readonly config: PollingLoopConfig,
  ) {}

  start(): void {
    if (this.loop || this.abort.signal.aborted) return;
    this.logger.info({ worker: this.config.name }, 'worker started');
    this.loop = this.run();
  }

  /** Interrupts the wait, lets the current iteration finish and resolves once the loop ended. Idempotent. */
  async stop(): Promise<void> {
    if (!this.abort.signal.aborted) this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      let wait = 0;
      try {
        if (!(await this.iteration())) wait = this.config.pollMs;
        failures = 0;
      } catch (e) {
        this.logger.error({ worker: this.config.name, error: describeError(e) }, 'worker iteration failed');
        wait = backoffDelayMs(failures++, { baseMs: this.config.pollMs, capMs: MAX_ERROR_BACKOFF_MS, jitter: this.jitter });
      }
      if (wait > 0) await this.pause(wait);
    }
    this.logger.info({ worker: this.config.name }, 'worker stopped');
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: Timer | undefined;
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        resolve();
      };
      this.abort.signal.addEventListener('abort', done, { once: true });
      timer = setTimeout(done, ms);
    });
  }
}

export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (cause: ${e.cause.name}: ${e.cause.message})` : '';
  return `${e.name}: ${e.message}${cause}`;
}
