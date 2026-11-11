import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfraError } from '../../../src/application/errors';
import type { EventPublisher } from '../../../src/application/ports/event-publisher';
import type { FaultInjector } from '../../../src/application/ports/fault-injector';
import { noopLogger, type AppLogger } from '../../../src/application/ports/logger';
import { noopMetrics } from '../../../src/application/ports/metrics';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { PublishOutbox } from '../../../src/application/use-cases/publish-outbox';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { loadEnv } from '../../../src/infrastructure/config/env';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';
import { createSqsClient } from '../../../src/infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { OutboxPublisherWorker } from '../../../src/interfaces/workers/outbox-publisher.worker';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { eventually } from '../../support/eventually';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId, outboxMessage, testOrm } from '../../support/persistence';
import { sqlClient } from '../../support/sql';
import { createTestQueues, type TestQueues } from '../../support/sqs';
import { fixedClock, recordingMetrics, wagerCommand } from '../../support/use-cases';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let sqs: SQSClient;
let q: TestQueues;
let metrics: ReturnType<typeof recordingMetrics>;
const clock = fixedClock();
const T0 = clock.now();
const ids = new UuidV7IdGenerator();
const noFaults: FaultInjector = { hit: () => {} };
const cleanups: Array<() => Promise<unknown>> = [];
/** 500-event tests publish and read real SQS batches. */
const SLOW = { timeout: 60_000 };

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await testOrm(db.url);
  uow = new MikroOrmUnitOfWork(orm, noopMetrics);
  sqs = createSqsClient(loadEnv({ DATABASE_URL: db.url }));
});

beforeEach(async () => {
  metrics = recordingMetrics();
  clock.set(T0);
  // Every test starts from an empty outbox and a queue of its own.
  await db.sql`UPDATE outbox_messages SET published_at = ${T0}, next_attempt_at = NULL WHERE published_at IS NULL`;
  q = await createTestQueues(sqs, 'outbox');
  cleanups.push(() => q.destroy());
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  await assertLedgerConsistency(db.sql);
});

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
  await db.drop();
});

function publishOutbox(
  over: { unitOfWork?: MikroOrmUnitOfWork; publisher?: EventPublisher; faults?: FaultInjector } = {},
): PublishOutbox {
  return new PublishOutbox(
    over.unitOfWork ?? uow,
    over.publisher ?? new SqsEventPublisher(sqs, q.eventsUrl),
    clock,
    over.faults ?? noFaults,
    metrics,
    () => 0,
  );
}

/** Publishes until nothing is due (or locked by someone else); returns how many this publisher published. */
async function drain(p: PublishOutbox): Promise<number> {
  let total = 0;
  for (;;) {
    const { published, retried } = await p.execute(50);
    total += published;
    if (published + retried === 0) return total;
  }
}

async function enqueue(count: number, groups = 25): Promise<string[]> {
  const aggregates = Array.from({ length: groups }, () => newId());
  const messages = Array.from({ length: count }, (_, i) => {
    const id = newId();
    const aggregateId = aggregates[i % groups]!;
    return outboxMessage({ id, aggregateId, payload: { eventId: id, eventType: 'WalletBalanceChanged', aggregateId } });
  });
  await uow.run(async (r) => {
    for (const m of messages) await r.outbox.enqueue(m);
  });
  return messages.map((m) => m.id);
}

/** Receives (and deletes, so FIFO groups keep flowing) until `expected` distinct eventIds arrived. */
async function receiveEvents(expected: number, timeoutMs = 30_000): Promise<Message[]> {
  const received: Message[] = [];
  const eventIds = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (eventIds.size < expected) {
    if (Date.now() > deadline) throw new Error(`received ${eventIds.size} of ${expected} events`);
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: q.eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) continue;
    received.push(...Messages);
    for (const m of Messages) eventIds.add(JSON.parse(m.Body ?? '{}').eventId);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: q.eventsUrl,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return received;
}

async function pendingRows(): Promise<number> {
  const [row] = await db.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
  return row.n;
}

function eventIdsOf(messages: Message[]): Set<string> {
  return new Set(messages.map((m) => JSON.parse(m.Body ?? '{}').eventId as string));
}

function capturingLogger(): AppLogger & { errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  return { ...noopLogger, errors, error: (obj: object, msg: string) => void errors.push({ ...obj, msg }) };
}

describe('PublishOutbox', () => {
  test('publishes pending events with envelope and marks them published', async () => {
    const wallet = await new OpenWallet(uow, clock, ids, noopMetrics).execute({
      playerId: newId(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'open',
    });
    await new SubmitWagerTransaction(uow, clock, ids, noFaults, noopMetrics, () => 0).execute(
      wagerCommand(wallet),
      { type: 'http' },
      'corr-1',
    );
    const rows: Array<{ id: string; aggregate_id: string; payload: unknown }> = await db.sql`
      SELECT id, aggregate_id, payload FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id`;
    expect(rows.map((r) => (r.payload as { eventType: string }).eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);

    clock.set(new Date(T0.getTime() + 1000));
    expect(await publishOutbox().execute(50)).toEqual({ published: 3, retried: 0 });

    const received = await receiveEvents(3);
    expect(received).toHaveLength(3);
    for (const row of rows) {
      const message = received.find((m) => m.Attributes?.MessageDeduplicationId === row.id);
      expect(message).toBeDefined();
      expect(JSON.parse(message!.Body!)).toEqual(row.payload);
      expect(message!.Attributes?.MessageGroupId).toBe(row.aggregate_id);
      expect(row.aggregate_id).toBe(wallet.id);
    }
    const published = await db.sql`
      SELECT published_at, next_attempt_at, attempts FROM outbox_messages WHERE id IN ${db.sql(rows.map((r) => r.id))}`;
    expect(published).toEqual(Array(3).fill({ published_at: clock.now(), next_attempt_at: null, attempts: 0 }));
    expect(metrics.named('setOutboxPending')).toEqual([[0]]);
    expect(metrics.named('setOutboxLag')).toEqual([[0]]);
    expect(metrics.named('retry')).toEqual([]);
  });

  test('SQS failure schedules retry with backoff and keeps event pending', async () => {
    const [id] = await enqueue(1, 1);
    const unreachable = new SqsEventPublisher(sqs, `${q.eventsUrl.replace(/[^/]+$/, '')}missing-${newId()}.fifo`);

    expect(await publishOutbox({ publisher: unreachable }).execute(50)).toEqual({ published: 0, retried: 1 });
    const [row] = await db.sql`SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = ${id}`;
    // attempt 1: base 1s · 2^1, jitter off.
    expect(row).toEqual({ attempts: 1, next_attempt_at: new Date(T0.getTime() + 2000), published_at: null });
    expect(metrics.named('retry')).toEqual([['outbox']]);
    expect(metrics.named('setOutboxPending')).toEqual([[1]]);

    // Not due yet, even for a working publisher.
    expect(await publishOutbox().execute(50)).toEqual({ published: 0, retried: 0 });
    clock.set(new Date(T0.getTime() + 2000));
    expect(await publishOutbox().execute(50)).toEqual({ published: 1, retried: 0 });
    expect(eventIdsOf(await receiveEvents(1))).toEqual(new Set([id!]));
    expect(await pendingRows()).toBe(0);
  });

  test('publisher throwing rolls the batch back: rows stay due and the retry is counted', async () => {
    const enqueued = await enqueue(3, 1);
    const broken: EventPublisher = {
      publishBatch: async () => {
        throw new TransientInfraError('sqs down');
      },
    };

    await expect(publishOutbox({ publisher: broken }).execute(50)).rejects.toThrow('sqs down');
    expect(metrics.named('retry')).toEqual([['outbox'], ['outbox'], ['outbox']]);
    const rows = await db.sql`SELECT attempts, published_at FROM outbox_messages WHERE id IN ${db.sql(enqueued)}`;
    expect(rows).toEqual(Array(3).fill({ attempts: 0, published_at: null }));
    expect(await publishOutbox().execute(50)).toEqual({ published: 3, retried: 0 });
  });

  test(
    'two concurrent publishers (separate ORMs) publish 500 events: every eventId received ≥ 1 time, all marked published',
    async () => {
      const enqueued = await enqueue(500);
      const [ormA, ormB] = await Promise.all([testOrm(db.url), testOrm(db.url)]);
      cleanups.push(() => Promise.all([ormA.close(true), ormB.close(true)]));
      const a = publishOutbox({ unitOfWork: new MikroOrmUnitOfWork(ormA, noopMetrics) });
      const b = publishOutbox({ unitOfWork: new MikroOrmUnitOfWork(ormB, noopMetrics) });

      const [byA, byB] = await Promise.all([drain(a), drain(b)]);

      // SKIP LOCKED: disjoint batches, so no row was published by both.
      expect(byA + byB).toBe(500);
      expect(await pendingRows()).toBe(0);
      const received = eventIdsOf(await receiveEvents(500));
      for (const id of enqueued) expect(received.has(id)).toBe(true);
    },
    SLOW,
  );
});

describe('OutboxPublisherWorker', () => {
  test(
    'crash after publish before mark (FAULT throw) → event republished by next run; consumer-side dedup by eventId yields 500 unique',
    async () => {
      const enqueued = await enqueue(500);
      const faults: FaultInjector & { hits: number } = {
        hits: 0,
        hit(point) {
          if (point !== 'after_publish_before_mark') return;
          this.hits += 1;
          if (this.hits === 1) throw new TransientInfraError(`fault:${point}`);
        },
      };
      const sent: string[] = [];
      const real = new SqsEventPublisher(sqs, q.eventsUrl);
      const spy: EventPublisher = {
        publishBatch: (messages) => {
          sent.push(...messages.map((m) => m.id));
          return real.publishBatch(messages);
        },
      };
      const logger = capturingLogger();
      const worker = new OutboxPublisherWorker(publishOutbox({ publisher: spy, faults }), logger, () => 0, {
        batchSize: 50,
        pollMs: 50,
      });
      cleanups.push(() => worker.stop());
      worker.start();

      await eventually(async () => expect(await pendingRows()).toBe(0), { timeoutMs: 30_000 });
      await worker.stop();

      // The faulted batch rolled back (attempts untouched) and was sent again.
      expect(sent).toHaveLength(550);
      expect(new Set(sent).size).toBe(500);
      const attempts = await db.sql`SELECT DISTINCT attempts FROM outbox_messages WHERE id IN ${db.sql(enqueued)}`;
      expect(attempts).toEqual([{ attempts: 0 }]);
      expect(logger.errors).toEqual([expect.objectContaining({ error: 'TransientInfraError: fault:after_publish_before_mark' })]);
      const received = eventIdsOf(await receiveEvents(500));
      expect(received).toEqual(new Set(enqueued));
    },
    SLOW,
  );

  test('process holding the batch dies (connection closed) → another publisher takes over', async () => {
    const enqueued = await enqueue(10, 2);
    const holderClient = sqlClient(db.url);
    cleanups.push(() => holderClient.close());
    const holder = await holderClient.reserve();
    await holder`BEGIN`;
    const locked = await holder`SELECT id FROM outbox_messages WHERE published_at IS NULL FOR UPDATE`;
    expect(locked).toHaveLength(10);
    const [{ pid }] = await holder`SELECT pg_backend_pid() AS pid`;

    const takeover = publishOutbox();
    expect(await takeover.execute(50)).toEqual({ published: 0, retried: 0 });

    await db.sql`SELECT pg_terminate_backend(${pid})`;
    await eventually(async () => expect(await takeover.execute(50)).toEqual({ published: 10, retried: 0 }));
    expect(await pendingRows()).toBe(0);
    expect(eventIdsOf(await receiveEvents(10))).toEqual(new Set(enqueued));
    await expect(holder`SELECT 1`).rejects.toThrow();
  });
});
