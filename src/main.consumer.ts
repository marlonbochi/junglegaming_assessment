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
import { NestPinoLogger } from './interfaces/http/nest-logger';
import { startOpsHttp } from './interfaces/ops-http';
import { ConsumerModule } from './interfaces/sqs/consumer.module';
import { WagerTransactionConsumer } from './interfaces/sqs/wager-transaction.consumer';
import { METRICS } from './interfaces/tokens';

/** Test seams; production uses the defaults built from `env`. */
export interface ConsumerOverrides {
  logger?: pino.Logger;
  faults?: FaultInjector;
}

/**
 * Builds the consumer context (not polling yet). `app.close()` stops the consumer, then releases the
 * ORM and SQS client.
 */
export async function bootstrapConsumer(env: Env, overrides: ConsumerOverrides = {}): Promise<INestApplicationContext> {
  const logger = overrides.logger ?? createLogger(env);
  return NestFactory.createApplicationContext(
    ConsumerModule.forRoot({ env, logger, sqs: createSqsClient(env), faults: overrides.faults }),
    { logger: new NestPinoLogger(logger) },
  );
}

if (import.meta.main) {
  const env = loadEnv();
  const app = await bootstrapConsumer(env);
  const consumer = app.get(WagerTransactionConsumer);
  consumer.start();
  const ops = startOpsHttp(env.PORT, app.get(HealthService), app.get<PromMetrics>(METRICS));
  const shutdown = async () => {
    await consumer.stop();
    await ops.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
