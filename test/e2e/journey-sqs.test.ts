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

describe.skipIf(!e2eEnabled)('e2e: SQS journey with integration events', () => {
  test('BET and WIN sent to the wager queue are applied and announced on wallet-events.fifo', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);

    const bet = wagerCommand(wallet, { roundId: 'sqs-r1', money: brl('25.00') });
    await sendWager(bet);
    const win = wagerCommand(wallet, { roundId: 'sqs-r1', kind: WagerTransactionKind.Win, money: brl('60.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await sendWager(win);

    await eventually(async () => expect(await balanceOf(wallet.id)).toBe('135.00'), { timeoutMs: 30_000 });
    const betTx = (await call(api, 'GET', `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`)).body;
    expect(betTx).toMatchObject({ status: 'PROCESSED', kind: 'BET', observedBalance: brl('75.00') });
    const winTx = (await call(api, 'GET', `/providers/provider-a/wagering/transactions/${win.externalTransactionId}`)).body;
    expect(winTx).toMatchObject({ status: 'PROCESSED', kind: WagerTransactionKind.Win, observedBalance: brl('135.00') });

    const mine = (type: string, txId: string) => (_m: unknown, b: any) =>
      b?.aggregateId === wallet.id && b.eventType === type && b.data?.transactionId === txId;
    const [processed] = await eventsTap.where(mine('WagerTransactionProcessed', betTx.id));
    const [changed] = await eventsTap.where(mine('WalletBalanceChanged', betTx.id));
    await eventsTap.where(mine('WagerTransactionProcessed', winTx.id));

    const processedBody = JSON.parse(processed!.Body!);
    expectEnvelope(processedBody, 'WagerTransactionProcessed', wallet.id);
    expect(processedBody.causationId).toBe(betTx.id);
    expect(processedBody.data).toMatchObject({ transactionId: betTx.id, kind: 'BET', walletId: wallet.id });

    const changedBody = JSON.parse(changed!.Body!);
    expectEnvelope(changedBody, 'WalletBalanceChanged', wallet.id);
    expect(changedBody.data).toMatchObject({
      walletId: wallet.id,
      transactionId: betTx.id,
      direction: 'DEBIT',
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
      walletVersion: 2,
    });
    expect(changed!.Attributes?.MessageGroupId).toBe(wallet.id);
  });

  test('a rejected SQS wager is acked (not dead-lettered) and announced as WagerTransactionRejected', async () => {
    const wallet = await openWallet('5.00');
    wallets.push(wallet.id);
    const bet = wagerCommand(wallet, { money: brl('25.00') });
    await sendWager(bet);
    const tx = await eventually(
      async () => {
        const res = await call(api, 'GET', `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
        expect(res.body).toMatchObject({ status: 'REJECTED' });
        return res.body;
      },
      { timeoutMs: 30_000 },
    );
    const [rejected] = await eventsTap.where((_m, b) => b?.eventType === 'WagerTransactionRejected' && b.data?.transactionId === tx.id);
    expectEnvelope(JSON.parse(rejected!.Body!), 'WagerTransactionRejected', wallet.id);
    expect(await balanceOf(wallet.id)).toBe('5.00');
  });
});
