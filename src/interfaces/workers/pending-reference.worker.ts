import type { AppLogger } from '../../application/ports/logger';
import type { RetryPendingReferences } from '../../application/use-cases/retry-pending-references';
import { PollingLoop } from './polling-loop';

export interface PendingReferenceWorkerConfig {
  batchSize: number;
  pollMs: number;
}

/** Spec §6.4 loop: retries due PENDING_REFERENCE transactions, waits `pollMs` when none was due. */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop;

  constructor(retry: RetryPendingReferences, logger: AppLogger, jitter: () => number, config: PendingReferenceWorkerConfig) {
    this.loop = new PollingLoop(
      async () => {
        const { resolved, rescheduled, expired } = await retry.execute(config.batchSize);
        if (expired > 0) logger.warn({ worker: 'pending-reference', expired }, 'pending references expired');
        return resolved + rescheduled + expired > 0;
      },
      logger,
      jitter,
      { name: 'pending-reference', pollMs: config.pollMs },
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
