import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplicationContext } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfraError } from '../../../src/application/errors';
import type { FaultInjector, FaultPoint } from '../../../src/application/ports/fault-injector';
import { noopMetrics } from '../../../src/application/ports/metrics';
import { loadEnv } from '../../../src/infrastructure/config/env';
import { HealthService } from '../../../src/infrastructure/observability/health';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import type { PromMetrics } from '../../../src/infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createSqsClient } from '../../../src/infrastructure/sqs/sqs-client';
import { startOpsHttp } from '../../../src/interfaces/ops-http';
import { WagerTransactionConsumer } from '../../../src/interfaces/sqs/wager-transaction.consumer';
import { METRICS } from '../../../src/interfaces/tokens';
import { bootstrapConsumer } from '../../../src/main.consumer';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { eventually } from '../../support/eventually';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { latch, newId, persistOpenedWallet, testOrm } from '../../support/persistence';
import { createTestQueues, queueCounts, receiveAll, sendWagerMessage, type TestQueueOptions, type TestQueues } from '../../support/sqs';

let db: TestDatabase;
let orm: MikroORM;
let sqs: SQSClient;
const cleanups: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  sqs = createSqsClient(loadEnv({ DATABASE_URL: db.url }));
});

afterEach(async () => {
  // Consumers first (LIFO), then their queues.
  while (cleanups.length > 0) await cleanups.pop()?.();
  await assertLedgerConsistency(db.sql);
});

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
  await db.drop();
});

const CONSUMER_NAME = 'wager-transactions-consumer';
/** Retry and redrive tests wait for real visibility timeouts (1s, 2s, ...). */
const SLOW = { timeout: 30_000 };

async function queues(opts: TestQueueOptions = {}): Promise<TestQueues> {
  const created = await createTestQueues(sqs, 'consumer', { visibilityTimeout: 2, ...opts });
  cleanups.push(() => created.destroy());
  return created;
}

interface StartedConsumer {
  app: INestApplicationContext;
  consumer: WagerTransactionConsumer;
  metrics: PromMetrics;
}

async function startConsumer(
  q: Pick<TestQueues, 'queueUrl' | 'dlqUrl' | 'eventsUrl'>,
  opts: { env?: Record<string, string>; faults?: FaultInjector; logLines?: Array<Record<string, unknown>>; start?: boolean } = {},
): Promise<StartedConsumer> {
  const env = loadEnv({
    DATABASE_URL: db.url,
    DB_POOL_MAX: '5',
    JITTER: 'off',
    LOG_LEVEL: 'silent',
    WAGER_QUEUE_URL: q.queueUrl,
    WAGER_DLQ_URL: q.dlqUrl,
    EVENTS_QUEUE_URL: q.eventsUrl,
    SQS_VISIBILITY_TIMEOUT_S: '2',
    ...opts.env,
  });
  const lines = opts.logLines;
  const logger = lines ? createLogger({ LOG_LEVEL: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) }) : undefined;
  const app = await bootstrapConsumer(env, { faults: opts.faults, logger });
  cleanups.push(() => app.close());
  const consumer = app.get(WagerTransactionConsumer);
  if (opts.start !== false) consumer.start();
  return { app, consumer, metrics: app.get<PromMetrics>(METRICS) };
}

/** Throws a transient error on the first `times` hits of `point` (forever when `times` is Infinity). */
function transientFaults(point: FaultPoint, times: number): FaultInjector & { hits: number } {
  return {
    hits: 0,
    hit(p) {
      if (p !== point) return;
      this.hits += 1;
      if (this.hits <= times) throw new TransientInfraError(`fault:${p}`);
    },
  };
}

interface WalletRef {
  id: string;
  playerId: string;
}

async function openWallet(amount = '100.00'): Promise<WalletRef> {
  const { wallet } = await new MikroOrmUnitOfWork(orm, noopMetrics).run((r) => persistOpenedWallet(r, amount));
  return { id: wallet.id, playerId: wallet.playerId };
}

function wagerData(wallet: WalletRef, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const externalTransactionId = `ext-${newId()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

async function wagers(walletId: string): Promise<Array<{ id: string; status: string; kind: string; failure_code: string | null }>> {
  return db.sql`
    SELECT id, status, kind, failure_code FROM wager_transactions
     WHERE wallet_id = ${walletId} AND kind <> 'OPENING' ORDER BY created_at`;
}

async function balance(walletId: string): Promise<string> {
  const [row] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return row.balance;
}

async function expectQueueEmpty(queueUrl: string): Promise<void> {
  await eventually(async () => expect(await queueCounts(sqs, queueUrl)).toEqual({ visible: 0, inFlight: 0 }));
}

async function metricsText(m: PromMetrics): Promise<string> {
  return m.registry.metrics();
}

describe('processing', () => {
  test('valid BET message processed, acked, inbox row written, queue empty', async () => {
    const q = await queues();
    const logLines: Array<Record<string, unknown>> = [];
    const { metrics } = await startConsumer(q, { logLines });
    const wallet = await openWallet();
    const data = wagerData(wallet);
    const { messageId } = await sendWagerMessage(sqs, q.queueUrl, data);

    const [tx] = await eventually(async () => {
      const rows = await wagers(wallet.id);
      expect(rows).toEqual([expect.objectContaining({ status: 'PROCESSED', kind: 'BET' })]);
      return rows;
    });
    expect(await balance(wallet.id)).toBe('75.00');
    const inbox = await db.sql`SELECT consumer_name FROM inbox_messages WHERE message_id = ${messageId}`;
    expect(inbox).toEqual([{ consumer_name: CONSUMER_NAME }]);
    const correlations = await db.sql`
      SELECT DISTINCT payload->>'correlationId' AS correlation_id FROM outbox_messages WHERE payload->>'causationId' = ${tx!.id}`;
    expect(correlations).toEqual([{ correlation_id: messageId }]);
    await expectQueueEmpty(q.queueUrl);
    expect(await metricsText(metrics)).toContain('wagering_transactions_total{status="PROCESSED",kind="BET",source="sqs"} 1');

    const handled = await eventually(async () => {
      const line = logLines.find((l) => l.messageId === messageId && l.msg === 'message processed');
      expect(line).toBeDefined();
      return line;
    });
    expect(handled).toMatchObject({
      correlationId: messageId,
      walletId: wallet.id,
      providerId: 'provider-a',
      transactionId: tx!.id,
      status: 'PROCESSED',
      action: 'ack',
    });
    expect(JSON.stringify(logLines)).not.toContain('25.00');
  });

  test('uppercase playerId/walletId are normalized and processed', async () => {
    const q = await queues();
    await startConsumer(q);
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet, { playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() }));
    await eventually(async () => {
      expect(await wagers(wallet.id)).toEqual([expect.objectContaining({ status: 'PROCESSED', kind: 'BET' })]);
    });
    expect(await balance(wallet.id)).toBe('75.00');
    await expectQueueEmpty(q.queueUrl);
  });

  test('duplicated message (two sends, different SQS MessageId, same messageId) → one debit, duplicate metric', async () => {
    const q = await queues();
    const { metrics } = await startConsumer(q);
    const wallet = await openWallet();
    const data = wagerData(wallet);
    const first = await sendWagerMessage(sqs, q.queueUrl, data, { messageId: 'msg-dup', deduplicationId: 'dedup-1' });
    const second = await sendWagerMessage(sqs, q.queueUrl, data, { messageId: 'msg-dup', deduplicationId: 'dedup-2' });
    expect(second.sqsMessageId).not.toBe(first.sqsMessageId);

    await expectQueueEmpty(q.queueUrl);
    await eventually(async () => expect(await metricsText(metrics)).toContain('wagering_duplicates_total{source="sqs",type="inbox"} 1'));
    expect(await wagers(wallet.id)).toHaveLength(1);
    expect(await balance(wallet.id)).toBe('75.00');
  });

  test('business outcomes (REJECTED, PENDING_REFERENCE) are acked, not dead-lettered', async () => {
    const q = await queues();
    await startConsumer(q);
    const wallet = await openWallet('10.00');
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet, { money: { amount: '25.00', currency: 'BRL' } }));
    await sendWagerMessage(
      sqs,
      q.queueUrl,
      wagerData(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `missing-${newId()}` }),
    );

    await eventually(async () =>
      expect((await wagers(wallet.id)).map((t) => t.status)).toEqual(['REJECTED', 'PENDING_REFERENCE']),
    );
    await expectQueueEmpty(q.queueUrl);
    expect(await receiveAll(sqs, q.dlqUrl, { waitMs: 500 })).toEqual([]);
  });
});

describe('dead-lettering', () => {
  test.each<[string, (w: WalletRef) => { data: Record<string, unknown>; rawBody?: string }, string]>([
    ['invalid JSON', (w) => ({ data: wagerData(w), rawBody: '{"messageId":' }), 'INVALID_PAYLOAD'],
    ['OPENING kind', (w) => ({ data: wagerData(w, { kind: 'OPENING' }) }), 'INVALID_PAYLOAD'],
    ['unknown wallet', () => ({ data: wagerData({ id: newId(), playerId: newId() }) }), 'WALLET_NOT_FOUND'],
  ])('%s goes to DLQ with reason attribute and is deleted from main queue', async (_name, build, reason) => {
    const q = await queues();
    const { metrics } = await startConsumer(q);
    const wallet = await openWallet();
    const { data, rawBody } = build(wallet);
    const sent = await sendWagerMessage(sqs, q.queueUrl, data, { rawBody });

    const [dead] = await eventually(async () => {
      const messages = await receiveAll(sqs, q.dlqUrl, { waitMs: 500 });
      expect(messages).toHaveLength(1);
      return messages;
    });
    expect(dead!.Body).toBe(sent.body);
    expect(dead!.MessageAttributes?.reason).toEqual({ DataType: 'String', StringValue: reason });
    expect(dead!.Attributes?.MessageGroupId).toBe(String(data.walletId));
    // An unreadable envelope falls back to the SQS MessageId.
    expect(dead!.Attributes?.MessageDeduplicationId).toBe(`${rawBody ? sent.sqsMessageId : sent.messageId}:${reason}`);
    await expectQueueEmpty(q.queueUrl);
    expect(await metricsText(metrics)).toContain(`sqs_dlq_messages_total{reason="${reason}"} 1`);
    expect(await wagers(wallet.id)).toEqual([]);
  });
});

describe('retries', () => {
  test('transient failure (before_commit throws transient) retries until success without duplicating', async () => {
    const q = await queues();
    const faults = transientFaults('before_commit', 2);
    const { metrics } = await startConsumer(q, { faults });
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));

    await eventually(async () => expect(await wagers(wallet.id)).toEqual([expect.objectContaining({ status: 'PROCESSED' })]), {
      timeoutMs: 20_000,
    });
    await expectQueueEmpty(q.queueUrl);
    expect(faults.hits).toBe(3);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await metricsText(metrics)).toContain('wagering_retries_total{component="consumer"} 2');
    expect(await receiveAll(sqs, q.dlqUrl, { waitMs: 500 })).toEqual([]);
  }, SLOW);

  test('failure after commit and before ack: redelivery is an inbox replay, acked, one debit', async () => {
    const q = await queues();
    const { metrics } = await startConsumer(q, { faults: transientFaults('after_commit_before_ack', 1) });
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));

    await eventually(async () => expect(await metricsText(metrics)).toContain('wagering_duplicates_total{source="sqs",type="inbox"} 1'), {
      timeoutMs: 20_000,
    });
    await expectQueueEmpty(q.queueUrl);
    expect(await wagers(wallet.id)).toHaveLength(1);
    expect(await balance(wallet.id)).toBe('75.00');
  }, SLOW);

  test('repeated transient failures reach DLQ through redrive after maxReceiveCount', async () => {
    const q = await queues({ maxReceiveCount: 2 });
    const { metrics } = await startConsumer(q, { faults: transientFaults('before_commit', Infinity) });
    const wallet = await openWallet();
    const { messageId } = await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));

    const [dead] = await eventually(
      async () => {
        const messages = await receiveAll(sqs, q.dlqUrl, { waitMs: 500 });
        expect(messages).toHaveLength(1);
        return messages;
      },
      { timeoutMs: 20_000 },
    );
    expect(JSON.parse(dead!.Body!).messageId).toBe(messageId);
    // Moved by the redrive policy, not by the consumer.
    expect(dead!.MessageAttributes?.reason).toBeUndefined();
    expect(await metricsText(metrics)).toContain('wagering_retries_total{component="consumer"} 2');
    expect(await metricsText(metrics)).not.toContain('sqs_dlq_messages_total{');
    await expectQueueEmpty(q.queueUrl);
    expect(await wagers(wallet.id)).toEqual([]);
  }, SLOW);
});

describe('lifecycle', () => {
  test('stop() during in-flight message completes it; unprocessed messages become visible immediately', async () => {
    const q = await queues({ visibilityTimeout: 30 });
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));
    const second = await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));

    // Hold the wallet lock so the first message stays in flight.
    const held = latch();
    const locked = latch();
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked.release();
      await held.promise;
    });
    await locked.promise;
    const { consumer } = await startConsumer(q, { env: { SQS_VISIBILITY_TIMEOUT_S: '30' } });
    await eventually(async () => {
      const [row] = await db.sql`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(row.n).toBe(1);
    });

    const stopping = consumer.stop();
    held.release();
    await holder;
    await stopping;

    // stop() resolved only after the in-flight message committed.
    expect(await wagers(wallet.id)).toEqual([expect.objectContaining({ status: 'PROCESSED' })]);
    // Well before the 30s visibility timeout: released with visibility 0 after being received once.
    const visible = await receiveAll(sqs, q.queueUrl, { waitMs: 1000 });
    expect(visible.map((m) => JSON.parse(m.Body!).messageId)).toEqual([second.messageId]);
    expect(visible[0]!.Attributes?.ApproximateReceiveCount).toBe('2');
  });

  test('receive errors (queue unreachable) are retried with backoff and never crash the loop', async () => {
    const q = await queues();
    const missing = { ...q, queueUrl: `${q.queueUrl.replace(/[^/]+$/, '')}does-not-exist.fifo` };
    const { consumer, metrics } = await startConsumer(missing);
    await eventually(async () => expect(await metricsText(metrics)).toMatch(/wagering_retries_total\{component="consumer-receive"\} [1-9]/));
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('ops http: live 200, ready 200 / 503 when the queue is unreachable, metrics in prometheus format', async () => {
    const q = await queues();
    const healthy = await startConsumer(q, { start: false });
    const unreachable = await startConsumer(
      { ...q, queueUrl: `${q.queueUrl.replace(/[^/]+$/, '')}does-not-exist.fifo` },
      { start: false },
    );
    const servers = [healthy, unreachable].map(({ app, metrics }) => startOpsHttp(0, app.get(HealthService), metrics));
    cleanups.push(async () => servers.forEach((s) => s.stop(true)));
    const [ok, down] = servers.map((s) => `http://127.0.0.1:${s.port}`);

    const live = await fetch(`${ok}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${ok}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'up', queue: 'up' } });
    const notReady = await fetch(`${down}/health/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: 'error', checks: { database: 'up', queue: 'down' } });
    const scrape = await fetch(`${ok}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get('content-type')).toStartWith('text/plain');
    expect(await scrape.text()).toContain('# HELP wagering_transactions_total');
    expect((await fetch(`${ok}/nope`)).status).toBe(404);
  });

  test('main.consumer: processes messages, serves ops http and exits 0 on SIGTERM', async () => {
    const q = await queues();
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn(['bun', 'src/main.consumer.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        DB_POOL_MAX: '3',
        WAGER_QUEUE_URL: q.queueUrl,
        WAGER_DLQ_URL: q.dlqUrl,
        EVENTS_QUEUE_URL: q.eventsUrl,
        PORT: String(port),
        LOG_LEVEL: 'silent',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    cleanups.push(async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    });

    await eventually(async () => expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200));
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerData(wallet));
    await eventually(async () => expect(await wagers(wallet.id)).toHaveLength(1));

    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe('');
  }, SLOW);
});
