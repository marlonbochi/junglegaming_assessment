import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrm } from '../../mikro-orm.config';
import type { Clock, IdGenerator } from '../application/ports/clock';
import type { FaultInjector } from '../application/ports/fault-injector';
import type { Metrics } from '../application/ports/metrics';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import { SubmitWagerTransaction } from '../application/use-cases/submit-wager-transaction';
import type { Env } from '../infrastructure/config/env';
import { HealthService } from '../infrastructure/observability/health';
import { PromMetrics } from '../infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/mikro-orm-unit-of-work';
import { EnvFaultInjector } from '../infrastructure/runtime/env-fault-injector';
import { SystemClock } from '../infrastructure/runtime/system-clock';
import { UuidV7IdGenerator } from '../infrastructure/runtime/uuid-v7-id-generator';
import { CLOCK, FAULTS, IDS, JITTER, METRICS, ORM, SQS, UNIT_OF_WORK } from './tokens';

export interface CoreModuleDeps {
  env: Env;
  sqs: SQSClient;
  faults?: FaultInjector;
}

/**
 * Infrastructure and the submission use case shared by every process (API, consumer). The ORM is
 * created here; the ORM and the SQS client are released on application shutdown.
 */
@Module({})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS) private readonly sqs: SQSClient,
  ) {}

  static forRoot(deps: CoreModuleDeps): DynamicModule {
    const { env } = deps;
    const providers = [
      { provide: SQS, useValue: deps.sqs },
      { provide: ORM, useFactory: () => createOrm(env) },
      { provide: METRICS, useFactory: () => new PromMetrics() },
      { provide: CLOCK, useFactory: () => new SystemClock() },
      { provide: IDS, useFactory: () => new UuidV7IdGenerator() },
      { provide: FAULTS, useFactory: () => deps.faults ?? new EnvFaultInjector(env.FAULT) },
      { provide: JITTER, useValue: env.JITTER === 'on' ? Math.random : () => 0 },
      {
        provide: UNIT_OF_WORK,
        inject: [ORM, METRICS],
        useFactory: (orm: MikroORM, metrics: Metrics) => new MikroOrmUnitOfWork(orm, metrics),
      },
      {
        provide: HealthService,
        inject: [ORM, SQS],
        useFactory: (orm: MikroORM, sqs: SQSClient) => new HealthService(orm, sqs, env.WAGER_QUEUE_URL),
      },
      {
        provide: SubmitWagerTransaction,
        inject: [UNIT_OF_WORK, CLOCK, IDS, FAULTS, METRICS, JITTER],
        useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, faults: FaultInjector, metrics: Metrics, jitter: () => number) =>
          new SubmitWagerTransaction(uow, clock, ids, faults, metrics, jitter),
      },
    ];
    return { module: CoreModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}
