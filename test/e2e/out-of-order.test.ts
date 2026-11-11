import { afterAll, describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.types';
import { eventually } from '../support/eventually';
import { call } from '../support/http';
import { wagerCommand } from '../support/use-cases';
import { api, balanceOf, brl, e2eEnabled, eventsTap, expectEnvelope, openWallet, reconcileAll, sendWager } from './setup';

const wallets: string[] = [];
afterAll(async () => {
  if (e2eEnabled) await reconcileAll(wallets);
});

const byExternal = (id: string) => call(api, 'GET', `/providers/provider-a/wagering/transactions/${id}`);

describe.skipIf(!e2eEnabled)('e2e: reference before target (out of order via SQS)', () => {
  test('ROLLBACK arriving before its BET waits as PENDING_REFERENCE and settles once the BET lands', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const bet = wagerCommand(wallet, { roundId: 'ooo', money: brl('30.00') });
    const rollback = wagerCommand(wallet, {
      roundId: 'ooo',
      kind: WagerTransactionKind.Rollback,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await sendWager(rollback);
    const pending = await eventually(
      async () => {
        const res = await byExternal(rollback.externalTransactionId);
        expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE' });
        return res.body;
      },
      { timeoutMs: 30_000 },
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');

    await sendWager(bet);
    await eventually(
      async () => {
        expect((await byExternal(rollback.externalTransactionId)).body).toMatchObject({ id: pending.id, status: 'PROCESSED' });
        expect((await byExternal(bet.externalTransactionId)).body).toMatchObject({ status: 'PROCESSED' });
      },
      { timeoutMs: 30_000 },
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const ledger = await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=10`);
    expect(ledger.body.items.map((e: any) => [e.direction, e.money.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '30.00'],
      ['CREDIT', '30.00'],
    ]);

    const [pendingEvent] = await eventsTap.where((_m, b) => b?.eventType === 'WagerTransactionPendingReference' && b.data?.transactionId === pending.id);
    expectEnvelope(JSON.parse(pendingEvent!.Body!), 'WagerTransactionPendingReference', wallet.id);
    expect(JSON.parse(pendingEvent!.Body!).data).toMatchObject({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: bet.externalTransactionId });
    const [done] = await eventsTap.where((_m, b) => b?.eventType === 'WagerTransactionProcessed' && b.data?.transactionId === pending.id);
    expectEnvelope(JSON.parse(done!.Body!), 'WagerTransactionProcessed', wallet.id);
  });
});
