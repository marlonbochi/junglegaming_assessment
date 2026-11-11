import { expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.types';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { openWalletVia } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { spawnService, withServiceLogs } from '../support/processes';
import { drainUntil, sendWagerMessage } from '../support/sqs';
import { wagerCommand } from '../support/use-cases';

const suite = concurrencySuite('c07');
const money = { amount: '30.00', currency: 'BRL' };

test(
  'scenario 7: ROLLBACK arrives over SQS before its BET → PENDING_REFERENCE, then both PROCESSED and the balance restored',
  withServiceLogs(async () => {
    const env = suite.env();
    const [api] = await Promise.all([spawnService('api', env), spawnService('consumer', env), spawnService('workers', env)]);
    const wallet = await openWalletVia(api, '100.00');
    const bet = wagerCommand(wallet, { roundId: 'round-7', money });
    const rollback = wagerCommand(wallet, {
      roundId: 'round-7',
      kind: WagerTransactionKind.Rollback,
      money,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await sendWagerMessage(suite.sqs, suite.queues.queueUrl, { ...rollback });
    const [pending] = await eventually(async () => {
      const rows = await suite.wagers(wallet.id);
      expect(rows).toEqual([expect.objectContaining({ kind: 'ROLLBACK', status: 'PENDING_REFERENCE' })]);
      return rows;
    });
    expect(await suite.balance(wallet.id)).toBe('100.00');

    await sendWagerMessage(suite.sqs, suite.queues.queueUrl, { ...bet });
    const settled = await eventually(
      async () => {
        const rows = await suite.wagers(wallet.id);
        expect(rows.map((r) => [r.kind, r.status]).sort()).toEqual([
          ['BET', 'PROCESSED'],
          ['ROLLBACK', 'PROCESSED'],
        ]);
        return rows;
      },
      { timeoutMs: 20_000 },
    );
    const betId = settled.find((r) => r.kind === 'BET')!.id;
    const [link] = await suite.db.sql`SELECT reference_transaction_id FROM wager_transactions WHERE id = ${pending!.id}`;
    expect(link.reference_transaction_id).toBe(betId);
    expect(await suite.balance(wallet.id)).toBe('100.00');
    const ledger = await suite.db.sql`
      SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id} ORDER BY wallet_version`;
    expect(ledger).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '30.00' },
      { direction: 'CREDIT', amount: '30.00' },
    ]);

    // wallet-events.fifo carries the whole story, published by the workers process.
    const wanted = [
      ['WagerTransactionPendingReference', pending!.id],
      ['WagerTransactionProcessed', betId],
      ['WagerTransactionProcessed', pending!.id],
    ];
    const seen = (bodies: Array<{ eventType: string; data: { transactionId?: string } }>) =>
      wanted.every(([type, id]) => bodies.some((b) => b.eventType === type && b.data.transactionId === id));
    const events = await drainUntil(suite.sqs, suite.queues.eventsUrl, (received) => seen(received.map((m) => JSON.parse(m.Body!))));
    const pendingEvent = events.map((m) => JSON.parse(m.Body!)).find((b) => b.eventType === 'WagerTransactionPendingReference');
    expect(pendingEvent).toMatchObject({
      aggregateId: wallet.id,
      data: { transactionId: pending!.id, kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId },
    });
    await assertLedgerConsistency(suite.db.sql);
  }),
);
