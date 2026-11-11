import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pino from 'pino';
import type { FaultInjector } from './application/ports/fault-injector';
import { loadEnv, type Env } from './infrastructure/config/env';
import { createLogger } from './infrastructure/observability/logger';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { ApiModule } from './interfaces/http/api.module';
import { NestPinoLogger } from './interfaces/http/nest-logger';
import { ProblemDetailsFilter } from './interfaces/http/problem-details.filter';
import { requestContextMiddleware } from './interfaces/http/request-context.middleware';

/** Test seams; production uses the defaults built from `env`. */
export interface ApiOverrides {
  logger?: pino.Logger;
  faults?: FaultInjector;
}

/** Builds the HTTP API (not listening yet). The ORM and SQS client are released on `app.close()`. */
export async function bootstrapApi(env: Env, overrides: ApiOverrides = {}): Promise<NestExpressApplication> {
  const logger = overrides.logger ?? createLogger(env);
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.forRoot({ env, logger, sqs: createSqsClient(env), faults: overrides.faults }),
    { logger: new NestPinoLogger(logger), bodyParser: false },
  );
  // Context first, so body-parser failures already carry the correlationId.
  app.use(requestContextMiddleware(logger));
  app.useBodyParser('json');
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const env = loadEnv();
  const app = await bootstrapApi(env);
  await app.listen(env.PORT);
}
