import { Inject, Module, type BeforeApplicationShutdown, type DynamicModule } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type pino from 'pino';
import type { FaultInjector } from '../../application/ports/fault-injector';
import type { Metrics } from '../../application/ports/metrics';
import { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import { toAppLogger } from '../../infrastructure/observability/logger';
import { CoreModule, type CoreModuleDeps } from '../core.module';
import { FAULTS, JITTER, METRICS, SQS } from '../tokens';
import { WagerTransactionConsumer } from './wager-transaction.consumer';

export interface ConsumerModuleDeps extends CoreModuleDeps {
  logger: pino.Logger;
}

/** The consumer on top of the shared CoreModule; it stops (draining in-flight messages) before the ORM closes. */
@Module({})
export class ConsumerModule implements BeforeApplicationShutdown {
  constructor(@Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer) {}

  static forRoot(deps: ConsumerModuleDeps): DynamicModule {
    const { env } = deps;
    return {
      module: ConsumerModule,
      imports: [CoreModule.forRoot(deps)],
      providers: [
        {
          provide: WagerTransactionConsumer,
          inject: [SQS, SubmitWagerTransaction, FAULTS, METRICS, JITTER],
          useFactory: (sqs: SQSClient, submit: SubmitWagerTransaction, faults: FaultInjector, metrics: Metrics, jitter: () => number) =>
            new WagerTransactionConsumer(sqs, submit, faults, metrics, toAppLogger(deps.logger), jitter, {
              queueUrl: env.WAGER_QUEUE_URL,
              dlqUrl: env.WAGER_DLQ_URL,
              consumerName: env.CONSUMER_NAME,
              visibilityTimeoutS: env.SQS_VISIBILITY_TIMEOUT_S,
              shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
            }),
        },
      ],
    };
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.consumer.stop();
  }
}
