import { Inject, Module, type BeforeApplicationShutdown, type DynamicModule } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type pino from 'pino';
import type { Clock, IdGenerator } from '../../application/ports/clock';
import type { FaultInjector } from '../../application/ports/fault-injector';
import type { Metrics } from '../../application/ports/metrics';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { PublishOutbox } from '../../application/use-cases/publish-outbox';
import { RetryPendingReferences } from '../../application/use-cases/retry-pending-references';
import { PENDING_REFERENCE_BACKOFF } from '../../domain/messaging/backoff';
import { toAppLogger } from '../../infrastructure/observability/logger';
import { SqsEventPublisher } from '../../infrastructure/sqs/sqs-event-publisher';
import { CoreModule, type CoreModuleDeps } from '../core.module';
import { CLOCK, FAULTS, IDS, JITTER, METRICS, SQS, UNIT_OF_WORK } from '../tokens';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

export interface WorkersModuleDeps extends CoreModuleDeps {
  logger: pino.Logger;
}

/** Outbox publisher and pending-reference worker on top of CoreModule; both stop before the ORM closes. */
@Module({})
export class WorkersModule implements BeforeApplicationShutdown {
  constructor(
    @Inject(OutboxPublisherWorker) private readonly publisher: OutboxPublisherWorker,
    @Inject(PendingReferenceWorker) private readonly pendingReferences: PendingReferenceWorker,
  ) {}

  static forRoot(deps: WorkersModuleDeps): DynamicModule {
    const { env } = deps;
    const logger = toAppLogger(deps.logger);
    return {
      module: WorkersModule,
      imports: [CoreModule.forRoot(deps)],
      providers: [
        {
          provide: OutboxPublisherWorker,
          inject: [UNIT_OF_WORK, SQS, CLOCK, FAULTS, METRICS, JITTER],
          useFactory: (uow: UnitOfWork, sqs: SQSClient, clock: Clock, faults: FaultInjector, metrics: Metrics, jitter: () => number) =>
            new OutboxPublisherWorker(
              new PublishOutbox(uow, new SqsEventPublisher(sqs, env.EVENTS_QUEUE_URL), clock, faults, metrics, logger, jitter),
              logger,
              jitter,
              { batchSize: env.OUTBOX_BATCH, pollMs: env.OUTBOX_POLL_MS },
            ),
        },
        {
          provide: PendingReferenceWorker,
          inject: [UNIT_OF_WORK, CLOCK, IDS, FAULTS, METRICS, JITTER],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, faults: FaultInjector, metrics: Metrics, jitter: () => number) =>
            new PendingReferenceWorker(
              new RetryPendingReferences(uow, clock, ids, faults, metrics, {
                maxAttempts: env.PENDING_REF_MAX_ATTEMPTS,
                ttlMs: env.PENDING_REF_TTL_MS,
                backoff: { ...PENDING_REFERENCE_BACKOFF, jitter },
              }),
              logger,
              jitter,
              { batchSize: env.PENDING_REF_BATCH, pollMs: env.PENDING_REF_POLL_MS },
            ),
        },
      ],
    };
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.publisher.stop(), this.pendingReferences.stop()]);
  }
}
