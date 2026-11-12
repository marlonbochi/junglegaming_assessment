import { expect, test } from 'bun:test';
import type { WagerCommand } from '../../src/application/commands/wager-command';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { call, openWalletVia, submitWager, type HttpResult } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { spawnServices, withServiceLogs, type ServiceHandle } from '../support/processes';
import { queueCounts, sendWagerMessage } from '../support/sqs';
import { centsToText, planWagers, runPool } from '../support/wager-load';

const VISIBILITY_S = 2;
const suite = concurrencySuite('c08', { visibilityTimeout: VISIBILITY_S });
const WALLETS = 12;
const OPS_PER_WALLET = 40;
const OPENING_CENTS = 10_000_000n;
const LANES = 8;
/** Pause between two ops of a lane: spreads the load over time (pacing, not synchronization). */
const PACE_MS = 10;
const HTTP_RETRY_MS = 100;

interface Stack {
  api: ServiceHandle;
  all: ServiceHandle[];
}

async function startStack(env: Record<string, string>): Promise<Stack> {
  const [[api], consumers, workers] = await Promise.all([
    spawnServices('api', 1, env),
    spawnServices('consumer', 3, env),
    spawnServices('workers', 2, env),
  ]);
  return { api: api!, all: [api!, ...consumers, ...workers] };
}

test(
  'scenario 8: SIGKILL of api, 3 consumers and 2 workers mid-load → restarted stack drains, every op applied exactly once',
  withServiceLogs(async () => {
    const env = suite.env({ SQS_VISIBILITY_TIMEOUT_S: String(VISIBILITY_S) });
    let stack = await startStack(env);
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(stack.api, centsToText(OPENING_CENTS))));
    const { ops, expectedCents } = planWagers(wallets, OPS_PER_WALLET, OPENING_CENTS);

    let dispatched = 0;
    let httpFailures = 0;
    /** A provider retries with the same idempotency key until it gets an answer (here: whichever api is up). */
    const submitUntilAnswered = async (cmd: WagerCommand): Promise<HttpResult> => {
      for (;;) {
        try {
          const res = await submitWager(stack.api, cmd);
          if (res.status < 500) return res;
        } catch {
          // Connection refused or reset: the api is down.
        }
        httpFailures += 1;
        await Bun.sleep(HTTP_RETRY_MS);
      }
    };
    const tasks = ops.map((cmd, i) => async () => {
      const outcome =
        i % 2 === 0 ? (await submitUntilAnswered(cmd)).status : await sendWagerMessage(suite.sqs, suite.queues.queueUrl, { ...cmd });
      dispatched += 1;
      await Bun.sleep(PACE_MS);
      return outcome;
    });
    const load = runPool(tasks, LANES);

    await eventually(async () => expect(dispatched).toBeGreaterThanOrEqual(ops.length * 0.4), { timeoutMs: 30_000, intervalMs: 10 });
    expect(dispatched).toBeLessThan(ops.length);
    const exitCodes = await Promise.all(stack.all.map((s) => s.kill('SIGKILL')));
    expect(exitCodes).toEqual(Array(stack.all.length).fill(137));

    stack = await startStack(env);
    const settled = await load;
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    const httpStatuses = settled.flatMap((s, i) => (i % 2 === 0 && s.status === 'fulfilled' ? [s.value] : []));
    expect(httpStatuses.filter((s) => s !== 200 && s !== 202)).toEqual([]);
    // The load really hit the dead stack.
    expect(httpFailures).toBeGreaterThan(0);

    await eventually(
      async () => {
        expect(await queueCounts(suite.sqs, suite.queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
        const [row] = await suite.db.sql`
          SELECT (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
                 (SELECT count(*)::int FROM wager_transactions
                   WHERE status = 'PENDING_REFERENCE' AND next_attempt_at < now() - interval '5 seconds') AS overdue,
                 (SELECT count(*)::int FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')) AS open`;
        expect(row).toEqual({ unpublished: 0, overdue: 0, open: 0 });
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    expect(await queueCounts(suite.sqs, suite.queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    const statuses = await suite.db.sql`
      SELECT status, count(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING' GROUP BY status`;
    expect(statuses).toEqual([{ status: 'PROCESSED', n: ops.length }]);
    for (const wallet of wallets) {
      const expected = centsToText(expectedCents.get(wallet.id)!);
      expect(await suite.balance(wallet.id)).toBe(expected);
      const reconciliation = await call(stack.api, 'POST', `/wallets/${wallet.id}/reconciliation`);
      expect(reconciliation.status).toBe(200);
      expect(reconciliation.body).toMatchObject({
        walletId: wallet.id,
        storedBalance: { amount: expected, currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
      });
    }
    await assertLedgerConsistency(suite.db.sql);
  }),
);
