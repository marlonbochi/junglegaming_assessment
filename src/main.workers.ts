import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type pino from 'pino';
import type { FaultInjector } from './application/ports/fault-injector';
import { loadEnv, type Env } from './infrastructure/config/env';
import { HealthService } from './infrastructure/observability/health';
import { createLogger } from './infrastructure/observability/logger';
import type { PromMetrics } from './infrastructure/observability/metrics';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { describeError } from './interfaces/describe-error';
import { NestPinoLogger } from './interfaces/http/nest-logger';
import { startOpsHttp } from './interfaces/ops-http';
import { METRICS } from './interfaces/tokens';
import { OutboxPublisherWorker } from './interfaces/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './interfaces/workers/pending-reference.worker';
import { WorkersModule } from './interfaces/workers/workers.module';

/** Test seams; production uses the defaults built from `env`. */
export interface WorkersOverrides {
  logger?: pino.Logger;
  faults?: FaultInjector;
}

/**
 * Builds the workers context (not running yet). `app.close()` stops both workers, then releases the
 * ORM and SQS client.
 */
export async function bootstrapWorkers(env: Env, overrides: WorkersOverrides = {}): Promise<INestApplicationContext> {
  const logger = overrides.logger ?? createLogger(env);
  return NestFactory.createApplicationContext(
    WorkersModule.forRoot({ env, logger, sqs: createSqsClient(env), faults: overrides.faults }),
    { logger: new NestPinoLogger(logger) },
  );
}

if (import.meta.main) {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = await bootstrapWorkers(env, { logger });
  const workers = [app.get(OutboxPublisherWorker), app.get(PendingReferenceWorker)];
  for (const worker of workers) worker.start();
  const ops = startOpsHttp(env.PORT, app.get(HealthService), app.get<PromMetrics>(METRICS));
  const shutdown = async () => {
    try {
      await Promise.all(workers.map((w) => w.stop()));
      await ops.stop();
      await app.close();
      process.exit(0);
    } catch (e) {
      logger.error({ error: describeError(e) }, 'workers shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
