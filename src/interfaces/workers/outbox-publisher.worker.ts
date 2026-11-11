import type { AppLogger } from '../../application/ports/logger';
import type { PublishOutbox } from '../../application/use-cases/publish-outbox';
import { PollingLoop } from './polling-loop';

export interface OutboxPublisherConfig {
  batchSize: number;
  pollMs: number;
}

/** Spec §6.5 loop: publishes outbox batches back to back, waits `pollMs` when nothing was due. */
export class OutboxPublisherWorker {
  private readonly loop: PollingLoop;

  constructor(publish: PublishOutbox, logger: AppLogger, jitter: () => number, config: OutboxPublisherConfig) {
    this.loop = new PollingLoop(
      async () => {
        const { published, retried } = await publish.execute(config.batchSize);
        return published + retried > 0;
      },
      logger,
      jitter,
      { name: 'outbox-publisher', pollMs: config.pollMs },
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
