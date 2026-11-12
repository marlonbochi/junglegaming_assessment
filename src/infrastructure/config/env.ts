import { z } from 'zod';
import type { FaultPoint } from '../../application/ports/fault-injector';

const LOCALSTACK_ENDPOINT = 'http://localhost:4566';
const LOCALSTACK_QUEUE_PREFIX = `${LOCALSTACK_ENDPOINT}/000000000000`;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const FAULT_POINTS: readonly FaultPoint[] = ['after_ledger_append', 'before_commit', 'after_commit_before_ack', 'after_publish_before_mark'];

const envSchema = z.object({
  DATABASE_URL: z.url(),
  AWS_ENDPOINT_URL: z.url().default(LOCALSTACK_ENDPOINT),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  WAGER_QUEUE_URL: z.url().default(`${LOCALSTACK_QUEUE_PREFIX}/wager-transactions.fifo`),
  WAGER_DLQ_URL: z.url().default(`${LOCALSTACK_QUEUE_PREFIX}/wager-transactions-dlq.fifo`),
  EVENTS_QUEUE_URL: z.url().default(`${LOCALSTACK_QUEUE_PREFIX}/wallet-events.fifo`),
  PORT: positiveInt(3000),
  CONSUMER_NAME: z.string().min(1).default('wager-transactions-consumer'),
  SQS_VISIBILITY_TIMEOUT_S: positiveInt(30),
  SQS_MAX_RECEIVE: positiveInt(5),
  SHUTDOWN_GRACE_MS: positiveInt(20_000),
  OUTBOX_BATCH: positiveInt(50),
  OUTBOX_POLL_MS: positiveInt(250),
  PENDING_REF_BATCH: positiveInt(20),
  PENDING_REF_POLL_MS: positiveInt(500),
  PENDING_REF_MAX_ATTEMPTS: positiveInt(10),
  PENDING_REF_TTL_MS: positiveInt(900_000),
  DB_POOL_MAX: positiveInt(20),
  FAULT: z
    .string()
    .regex(new RegExp(`^(${FAULT_POINTS.join('|')}):(crash|throw)$`), 'expected "<FaultPoint>:<crash|throw>"')
    .optional(),
  JITTER: z.enum(['on', 'off']).default('on'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AUTH_MODE: z.enum(['none', 'keycloak']).default('none'),
  /** Expected `iss` of the tokens (must match what Keycloak puts in them, whoever fetched the token). */
  KEYCLOAK_ISSUER: z.url().optional(),
  /** Where the API fetches the realm's signing keys; may be an internal address. */
  KEYCLOAK_JWKS_URL: z.url().optional(),
})
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE !== 'keycloak') return;
    for (const key of ['KEYCLOAK_ISSUER', 'KEYCLOAK_JWKS_URL'] as const) {
      if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'required when AUTH_MODE=keycloak' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parses and validates the process configuration; only `DATABASE_URL` is mandatory. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
