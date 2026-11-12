import { expect, test } from 'bun:test';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { openWalletVia } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { scrapeMetric, spawnService, withServiceLogs } from '../support/processes';
import { queueCounts, sendWagerMessage } from '../support/sqs';
import { wagerCommand } from '../support/use-cases';

const VISIBILITY_S = 2;
const suite = concurrencySuite('c05', { visibilityTimeout: VISIBILITY_S });

test(
  'scenario 5: consumer dies after commit, before ack → redelivered to a new consumer as a replay, one ledger effect',
  withServiceLogs(async () => {
    const env = suite.env({ SQS_VISIBILITY_TIMEOUT_S: String(VISIBILITY_S) });
    const api = await spawnService('api', env);
    const wallet = await openWalletVia(api, '100.00');
    const crashing = await spawnService('consumer', { ...env, FAULT: 'after_commit_before_ack:crash' });

    const { messageId } = await sendWagerMessage(suite.sqs, suite.queues.queueUrl, {
      ...wagerCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } }),
    });

    // The process exits on its own (not a signal), right after the commit.
    expect(await crashing.proc.exited).toBe(137);
    expect(crashing.proc.signalCode).toBeNull();
    const [committed] = await suite.wagers(wallet.id);
    expect(committed).toMatchObject({ kind: 'BET', status: 'PROCESSED' });
    expect(await suite.balance(wallet.id)).toBe('75.00');
    const counts = await queueCounts(suite.sqs, suite.queues.queueUrl);
    expect(counts.visible + counts.inFlight).toBe(1);

    const recovering = await spawnService('consumer', env);
    await eventually(async () => expect(await queueCounts(suite.sqs, suite.queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 }), {
      timeoutMs: 20_000,
    });
    await eventually(async () => {
      expect(await scrapeMetric(recovering, 'wagering_duplicates_total{source="sqs",type="inbox"}')).toBe(1);
      expect(await scrapeMetric(recovering, 'wagering_duplicates_total{source="sqs",type="replay"}')).toBe(1);
    });
    expect(await scrapeMetric(recovering, 'wagering_transactions_total{status="PROCESSED",kind="BET",source="sqs"}')).toBe(0);

    expect(await suite.wagers(wallet.id)).toEqual([committed!]);
    expect(await suite.debits(wallet.id)).toBe(1);
    expect(await suite.balance(wallet.id)).toBe('75.00');
    const inbox = await suite.db.sql`SELECT message_id FROM inbox_messages`;
    expect(inbox).toEqual([{ message_id: messageId }]);
    expect(await queueCounts(suite.sqs, suite.queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    await assertLedgerConsistency(suite.db.sql);
  }),
);
