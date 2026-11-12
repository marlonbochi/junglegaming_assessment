import { afterAll, describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.types';
import { call, submitWager } from '../support/http';
import { wagerCommand } from '../support/use-cases';
import { api, balanceOf, brl, e2eEnabled, openWallet, reconcileAll } from './setup';

const wallets: string[] = [];
afterAll(async () => {
  if (e2eEnabled) await reconcileAll(wallets);
});

describe.skipIf(!e2eEnabled)('e2e: full HTTP journey', () => {
  test('open wallet, BET / WIN / BET / ROLLBACK, paginate the ledger, reconcile', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);

    const bet1 = wagerCommand(wallet, { roundId: 'r1', money: brl('20.00') });
    const r1 = await submitWager(api, bet1);
    expect(r1).toMatchObject({ status: 200, body: { status: 'PROCESSED', balance: brl('80.00'), idempotentReplay: false } });

    const win = wagerCommand(wallet, { roundId: 'r1', kind: WagerTransactionKind.Win, money: brl('50.00'), referenceExternalTransactionId: bet1.externalTransactionId });
    expect((await submitWager(api, win)).body).toMatchObject({ status: 'PROCESSED', balance: brl('130.00') });

    const bet2 = wagerCommand(wallet, { roundId: 'r2', money: brl('30.00') });
    expect((await submitWager(api, bet2)).body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const rollback = wagerCommand(wallet, {
      roundId: 'r2',
      kind: WagerTransactionKind.Rollback,
      money: brl('30.00'),
      referenceExternalTransactionId: bet2.externalTransactionId,
    });
    const rb = await submitWager(api, rollback);
    expect(rb.body).toMatchObject({ status: 'PROCESSED', balance: brl('130.00') });

    expect(await balanceOf(wallet.id)).toBe('130.00');

    // Ledger: opening credit + 4 movements, walked two at a time.
    const entries: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      entries.push(...page.body.items);
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(entries.map((e) => [e.direction, e.money.amount, e.balanceAfter.amount])).toEqual([
      ['CREDIT', '100.00', '100.00'],
      ['DEBIT', '20.00', '80.00'],
      ['CREDIT', '50.00', '130.00'],
      ['DEBIT', '30.00', '100.00'],
      ['CREDIT', '30.00', '130.00'],
    ]);

    const byId = await call(api, 'GET', `/wagering/transactions/${rb.body.transactionId}`);
    expect(byId.body).toMatchObject({ kind: WagerTransactionKind.Rollback, status: 'PROCESSED', walletId: wallet.id, observedBalance: brl('130.00') });
    const byExternal = await call(api, 'GET', `/providers/provider-a/wagering/transactions/${rollback.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);

    const recon = await call(api, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(recon.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('130.00'),
      calculatedBalance: brl('130.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 5,
    });
  });

  test('insufficient funds is a 422 REJECTED and leaves the balance alone', async () => {
    const wallet = await openWallet('10.00');
    wallets.push(wallet.id);
    const res = await submitWager(api, wagerCommand(wallet, { money: brl('25.00') }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });
    expect(await balanceOf(wallet.id)).toBe('10.00');
  });
});
