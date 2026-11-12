import { expect, test } from 'bun:test';
import { noopMetrics } from '../../src/application/ports/metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { newId, outboxMessage, testOrm } from '../support/persistence';
import { spawnServices, withServiceLogs } from '../support/processes';
import { drainUntil, eventIdsOf } from '../support/sqs';

const suite = concurrencySuite('c06');
const EVENTS = 500;
const AGGREGATES = 25;

/** Commits `count` due events spread over `AGGREGATES` wallets in one transaction; returns their ids. */
async function enqueue(count: number): Promise<string[]> {
  const orm = await testOrm(suite.db.url);
  try {
    const aggregates = Array.from({ length: AGGREGATES }, () => newId());
    const at = new Date();
    const messages = Array.from({ length: count }, (_, i) => {
      const id = newId();
      const aggregateId = aggregates[i % AGGREGATES]!;
      return outboxMessage({ id, aggregateId, occurredAt: at, nextAttemptAt: at, payload: { eventId: id, eventType: 'WalletBalanceChanged', aggregateId } });
    });
    await new MikroOrmUnitOfWork(orm, noopMetrics).run(async (r) => {
      for (const m of messages) await r.outbox.enqueue(m);
    });
    return messages.map((m) => m.id);
  } finally {
    await orm.close(true);
  }
}

test(
  'scenario 6: two workers processes publish the same 500-event outbox → every eventId published, none left behind',
  withServiceLogs(async () => {
    // Small batches, so both publishers keep coming back for disjoint (SKIP LOCKED) batches.
    await spawnServices('workers', 2, suite.env({ OUTBOX_BATCH: '10', OUTBOX_POLL_MS: '50' }));
    const enqueued = await enqueue(EVENTS);

    await eventually(
      async () => {
        const [row] = await suite.db.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
        expect(row.n).toBe(0);
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    // Duplicates are allowed (at-least-once); consumers deduplicate by eventId.
    const received = await drainUntil(suite.sqs, suite.queues.eventsUrl, (r) => eventIdsOf(r).size >= EVENTS, { timeoutMs: 60_000 });
    expect(eventIdsOf(received)).toEqual(new Set(enqueued));
    await assertLedgerConsistency(suite.db.sql);
  }),
);
