import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type pino from 'pino';
import type { Clock, IdGenerator } from '../../application/ports/clock';
import type { Metrics } from '../../application/ports/metrics';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { GetTransaction } from '../../application/use-cases/get-transaction';
import { GetWallet } from '../../application/use-cases/get-wallet';
import { ListLedger } from '../../application/use-cases/list-ledger';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { ReconcileWallet } from '../../application/use-cases/reconcile-wallet';
import { JwtProviderIdentity } from '../../infrastructure/auth/jwt-provider-identity';
import { KeycloakJwtGuard } from '../../infrastructure/auth/keycloak-jwt.guard';
import { NoopAuthGuard } from '../../infrastructure/auth/noop-auth.guard';
import { NoopProviderIdentity } from '../../infrastructure/auth/noop-provider-identity';
import type { Env } from '../../infrastructure/config/env';
import { toAppLogger } from '../../infrastructure/observability/logger';
import { CoreModule, type CoreModuleDeps } from '../core.module';
import { CLOCK, IDS, METRICS, PROVIDER_IDENTITY, UNIT_OF_WORK } from '../tokens';
import { OpsController } from './controllers/ops.controller';
import { WagerTransactionsController } from './controllers/wager-transactions.controller';
import { WalletsController } from './controllers/wallets.controller';

export interface ApiModuleDeps extends CoreModuleDeps {
  logger: pino.Logger;
}

/** Spec §9: the global guard and the provider identity are chosen together by AUTH_MODE. */
function authProviders(env: Env): Provider[] {
  if (env.AUTH_MODE === 'keycloak') {
    // loadEnv fails fast when AUTH_MODE=keycloak lacks either variable.
    const guard = KeycloakJwtGuard.remote(env.KEYCLOAK_ISSUER!, env.KEYCLOAK_JWKS_URL!);
    return [
      { provide: PROVIDER_IDENTITY, useValue: new JwtProviderIdentity() },
      { provide: APP_GUARD, useValue: guard },
    ];
  }
  return [
    { provide: PROVIDER_IDENTITY, useValue: new NoopProviderIdentity() },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
  ];
}

/** Plain factory providers on top of the shared CoreModule (which owns the ORM and SQS client). */
@Module({})
export class ApiModule {
  static forRoot(deps: ApiModuleDeps): DynamicModule {
    const useCase = <T>(provide: new (...args: never[]) => T, inject: symbol[], factory: (...args: never[]) => T): Provider => ({
      provide,
      inject,
      useFactory: factory,
    });
    return {
      module: ApiModule,
      imports: [CoreModule.forRoot(deps)],
      controllers: [WalletsController, WagerTransactionsController, OpsController],
      providers: [
        ...authProviders(deps.env),
        useCase(OpenWallet, [UNIT_OF_WORK, CLOCK, IDS, METRICS], (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
          new OpenWallet(uow, clock, ids, metrics),
        ),
        useCase(GetWallet, [UNIT_OF_WORK], (uow: UnitOfWork) => new GetWallet(uow)),
        useCase(ListLedger, [UNIT_OF_WORK], (uow: UnitOfWork) => new ListLedger(uow)),
        useCase(GetTransaction, [UNIT_OF_WORK], (uow: UnitOfWork) => new GetTransaction(uow)),
        useCase(ReconcileWallet, [UNIT_OF_WORK, METRICS], (uow: UnitOfWork, metrics: Metrics) =>
          new ReconcileWallet(uow, metrics, toAppLogger(deps.logger)),
        ),
      ],
    };
  }
}
