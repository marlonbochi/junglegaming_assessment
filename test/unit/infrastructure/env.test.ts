import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../../../src/infrastructure/config/env';

const DATABASE_URL = 'postgres://postgres:postgres@localhost:55432/wagering';

describe('loadEnv', () => {
  test('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  test('defaults everything else to the local stack', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env).toEqual({
      DATABASE_URL,
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_REGION: 'us-east-1',
      WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
      WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
      EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wallet-events.fifo',
      PORT: 3000,
      CONSUMER_NAME: 'wager-transactions-consumer',
      SQS_VISIBILITY_TIMEOUT_S: 30,
      SQS_MAX_RECEIVE: 5,
      SHUTDOWN_GRACE_MS: 20_000,
      OUTBOX_BATCH: 50,
      OUTBOX_POLL_MS: 250,
      PENDING_REF_BATCH: 20,
      PENDING_REF_POLL_MS: 500,
      PENDING_REF_MAX_ATTEMPTS: 10,
      PENDING_REF_TTL_MS: 900_000,
      DB_POOL_MAX: 20,
      JITTER: 'on',
      LOG_LEVEL: 'info',
      AUTH_MODE: 'none',
    });
  });

  test('coerces numbers and validates enums and FAULT', () => {
    const env = loadEnv({ DATABASE_URL, PORT: '8080', JITTER: 'off', FAULT: 'after_commit_before_ack:crash' });
    expect(env.PORT).toBe(8080);
    expect(env.JITTER).toBe('off');
    expect(env.FAULT).toBe('after_commit_before_ack:crash');
    expect(() => loadEnv({ DATABASE_URL, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadEnv({ DATABASE_URL, AUTH_MODE: 'basic' })).toThrow(/AUTH_MODE/);
    expect(() => loadEnv({ DATABASE_URL, FAULT: 'nowhere:crash' })).toThrow(/FAULT/);
  });
});
