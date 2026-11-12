import { afterAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually';
import { newId } from '../support/persistence';
import { sendWagerMessage } from '../support/sqs';
import { wagerCommand } from '../support/use-cases';
import { balanceOf, brl, dlqTap, e2eEnabled, openWallet, reconcileAll, sendWager, sqs, wagerQueueUrl } from './setup';

const wallets: string[] = [];
afterAll(async () => {
  if (e2eEnabled) await reconcileAll(wallets);
});

const reasonOf = (m: { MessageAttributes?: Record<string, { StringValue?: string }> }) => m.MessageAttributes?.reason?.StringValue;

describe.skipIf(!e2eEnabled)('e2e: poison messages', () => {
  test('invalid JSON and invalid data land in the DLQ with reason INVALID_PAYLOAD; the group keeps flowing', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const marker = newId();

    // Same FIFO group as a good message sent right after: a poison message must not block it.
    const rawBody = `{"messageId":"${marker}",`;
    await sendWagerMessage(sqs, wagerQueueUrl, { walletId: wallet.id }, { rawBody, deduplicationId: `raw-${marker}` });

    const invalidMessageId = newId();
    await sendWager(wagerCommand(wallet, { money: { amount: '-5.00', currency: 'BRL' } }), { messageId: invalidMessageId });

    const good = wagerCommand(wallet, { money: brl('10.00') });
    await sendWager(good);

    const [rawDead] = await dlqTap.where((m) => m.Body === rawBody);
    expect(reasonOf(rawDead!)).toBe('INVALID_PAYLOAD');
    const [dataDead] = await dlqTap.where((_m, b) => b?.messageId === invalidMessageId);
    expect(reasonOf(dataDead!)).toBe('INVALID_PAYLOAD');
    expect(dataDead!.Attributes?.MessageGroupId).toBe(wallet.id);

    await eventually(async () => expect(await balanceOf(wallet.id)).toBe('90.00'), { timeoutMs: 30_000 });
  });

  test('a well-formed message for an unknown wallet is dead-lettered as WALLET_NOT_FOUND', async () => {
    const ghost = { id: newId(), playerId: newId() };
    const messageId = newId();
    await sendWager(wagerCommand(ghost), { messageId });
    const [dead] = await dlqTap.where((_m, b) => b?.messageId === messageId);
    expect(reasonOf(dead!)).toBe('WALLET_NOT_FOUND');
  });
});
