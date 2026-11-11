import { Inject, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type pino from 'pino';
import { createOrm } from '../../../mikro-orm.config';
import type { Clock, IdGenerator } from '../../application/ports/clock';
import type { FaultInjector } from '../../application/ports/fault-injector';
import type { Metrics } from '../../application/ports/metrics';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { GetTransaction } from '../../application/use-cases/get-transaction';
import { GetWallet } from '../../application/use-cases/get-wallet';
import { ListLedger } from '../../application/use-cases/list-ledger';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import { NoopAuthGuard } from '../../infrastructure/auth/noop-auth.guard';
import { NoopProviderIdentity } from '../../infrastructure/auth/noop-provider-identity';
import type { Env } from '../../infrastructure/config/env';
import { HealthService } from '../../infrastructure/observability/health';
import { toAppLogger } from '../../infrastructure/observability/logger';
import { PromMetrics } from '../../infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../../infrastructure/persistence/mikro-orm-unit-of-work';
import { EnvFaultInjector } from '../../infrastructure/runtime/env-fault-injector';
import { SystemClock } from '../../infrastructure/runtime/system-clock';
import { UuidV7IdGenerator } from '../../infrastructure/runtime/uuid-v7-id-generator';
import { OpsController } from './controllers/ops.controller';
import { WagerTransactionsController } from './controllers/wager-transactions.controller';
import { WalletsController } from './controllers/wallets.controller';
import { CLOCK, FAULTS, IDS, METRICS, ORM, PROVIDER_IDENTITY, SQS, UNIT_OF_WORK } from './tokens';

export interface ApiModuleDeps {
  env: Env;
  logger: pino.Logger;
  sqs: SQSClient;
  faults?: FaultInjector;
}

/** Plain factory providers: the ORM is created here and closed on application shutdown. */
@Module({})
export class ApiModule implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS) private readonly sqs: SQSClient,
  ) {}

  static forRoot(deps: ApiModuleDeps): DynamicModule {
    const { env } = deps;
    const useCase = <T>(provide: new (...args: never[]) => T, inject: symbol[], factory: (...args: never[]) => T): Provider => ({
      provide,
      inject,
      useFactory: factory,
    });
    return {
      module: ApiModule,
      controllers: [WalletsController, WagerTransactionsController, OpsController],
      providers: [
        { provide: SQS, useValue: deps.sqs },
        { provide: ORM, useFactory: () => createOrm(env) },
        { provide: METRICS, useFactory: () => new PromMetrics() },
        { provide: CLOCK, useFactory: () => new SystemClock() },
        { provide: IDS, useFactory: () => new UuidV7IdGenerator() },
        { provide: FAULTS, useFactory: () => deps.faults ?? new EnvFaultInjector(env.FAULT) },
        { provide: PROVIDER_IDENTITY, useFactory: () => new NoopProviderIdentity() },
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
        useCase(OpenWallet, [UNIT_OF_WORK, CLOCK, IDS, METRICS], (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
          new OpenWallet(uow, clock, ids, metrics),
        ),
        useCase(
          SubmitWagerTransaction,
          [UNIT_OF_WORK, CLOCK, IDS, FAULTS, METRICS],
          (uow: UnitOfWork, clock: Clock, ids: IdGenerator, faults: FaultInjector, metrics: Metrics) =>
            new SubmitWagerTransaction(uow, clock, ids, faults, metrics, env.JITTER === 'on' ? Math.random : () => 0),
        ),
        useCase(GetWallet, [UNIT_OF_WORK], (uow: UnitOfWork) => new GetWallet(uow)),
        useCase(ListLedger, [UNIT_OF_WORK], (uow: UnitOfWork) => new ListLedger(uow)),
        useCase(GetTransaction, [UNIT_OF_WORK], (uow: UnitOfWork) => new GetTransaction(uow)),
        useCase(ReconcileWallet, [UNIT_OF_WORK, METRICS], (uow: UnitOfWork, metrics: Metrics) =>
          new ReconcileWallet(uow, metrics, toAppLogger(deps.logger)),
        ),
        { provide: APP_GUARD, useClass: NoopAuthGuard },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}
