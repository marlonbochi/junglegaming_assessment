import { expect, test } from 'bun:test';
import type { WagerCommand } from '../../src/application/commands/wager-command';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { openWalletVia, submitWager, type HttpTarget } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { newId } from '../support/persistence';
import { scrapeMetric, spawnServices, withServiceLogs } from '../support/processes';
import { queueCounts, sendWagerMessage } from '../support/sqs';
import { centsToText, planWagers, runPool, shuffle } from '../support/wager-load';

const suite = concurrencySuite('c04');
const WALLETS = 12;
const OPS_PER_WALLET = 50;
const OPENING_CENTS = 10_000_000n;
const IN_FLIGHT = 32;

test(
  'scenario 4: 3 api + 3 consumer processes share 600 mixed ops (half HTTP, half SQS with duplicates) exactly once',
  withServiceLogs(async () => {
    const env = suite.env();
    const [apis, consumers] = await Promise.all([
      spawnServices('api', 3, env),
      spawnServices('consumer', 3, env),
      spawnServices('workers', 1, env),
    ]);
    const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, i) => openWalletVia(apis[i % 3]!, centsToText(OPENING_CENTS))));
    const { ops, expectedCents } = planWagers(wallets, OPS_PER_WALLET, OPENING_CENTS);

    const httpStatuses: number[] = [];
    const sqsMessageIds = new Set<string>();
    let sqsDuplicates = 0;
    type Send = () => Promise<unknown>;
    const httpSend = (cmd: WagerCommand, api: HttpTarget): Send => () => submitWager(api, cmd).then((r) => httpStatuses.push(r.status));
    const sqsSend = (cmd: WagerCommand, messageId = newId()): Send => {
      sqsMessageIds.add(messageId);
      return () => sendWagerMessage(suite.sqs, suite.queues.queueUrl, { ...cmd }, { messageId, deduplicationId: newId() });
    };
    const tasks = ops.flatMap((cmd, i): Send[] => {
      if (i % 2 === 0) {
        // Every 5th HTTP op is resent (replay), every 7th also arrives over SQS (cross-channel replay).
        const http = httpSend(cmd, apis[i % 3]!);
        return [http, ...(i % 5 === 0 ? [http] : []), ...(i % 7 === 0 ? [sqsSend(cmd)] : [])];
      }
      // Every other SQS op is delivered twice: same envelope messageId, different SQS deduplication id.
      const messageId = newId();
      if (i % 4 === 1) {
        sqsDuplicates += 1;
        return [sqsSend(cmd, messageId), sqsSend(cmd, messageId)];
      }
      return [sqsSend(cmd, messageId)];
    });

    const settled = await runPool(shuffle(tasks), IN_FLIGHT);
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    expect(httpStatuses.filter((s) => s !== 200 && s !== 202)).toEqual([]);

    await eventually(
      async () => {
        expect(await queueCounts(suite.sqs, suite.queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
        const [row] = await suite.db.sql`
          SELECT (SELECT count(*)::int FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')) AS open,
                 (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished`;
        expect(row).toEqual({ open: 0, unpublished: 0 });
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    expect(await queueCounts(suite.sqs, suite.queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    // Every distinct op became exactly one transaction, and every one was applied.
    const statuses = await suite.db.sql`
      SELECT status, count(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING' GROUP BY status`;
    expect(statuses).toEqual([{ status: 'PROCESSED', n: ops.length }]);
    const [{ negative }] = await suite.db.sql`SELECT count(*)::int AS negative FROM wallets WHERE balance < 0`;
    expect(negative).toBe(0);
    for (const wallet of wallets) expect(await suite.balance(wallet.id)).toBe(centsToText(expectedCents.get(wallet.id)!));
    // The shuffle delivered dependants before their BETs: those waited in PENDING_REFERENCE and resolved.
    const [{ pended }] = await suite.db.sql`
      SELECT count(*)::int AS pended FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference'`;
    expect(pended).toBeGreaterThan(0);

    // One inbox row per SQS messageId: duplicates never recorded (nor applied) twice.
    const inbox: Array<{ message_id: string; n: number }> = await suite.db.sql`
      SELECT message_id, count(*)::int AS n FROM inbox_messages GROUP BY consumer_name, message_id`;
    expect(inbox.filter((r) => r.n > 1)).toEqual([]);
    expect(new Set(inbox.map((r) => r.message_id))).toEqual(sqsMessageIds);
    const inboxDuplicates = await Promise.all(
      consumers.map((c) => scrapeMetric(c, 'wagering_duplicates_total{source="sqs",type="inbox"}')),
    );
    expect(inboxDuplicates.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(sqsDuplicates);
    // The wallets' message groups were spread over all three consumer processes.
    const betsPerConsumer = await Promise.all(
      consumers.map((c) => scrapeMetric(c, 'wagering_transactions_total{status="PROCESSED",kind="BET",source="sqs"}')),
    );
    for (const bets of betsPerConsumer) expect(bets).toBeGreaterThan(0);

    await assertLedgerConsistency(suite.db.sql);
  }),
);
