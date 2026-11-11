import { afterAll, describe, expect, test } from 'bun:test';
import { call, submitWager } from '../support/http';
import { newId } from '../support/persistence';
import { wagerCommand } from '../support/use-cases';
import { api, balanceOf, brl, e2eEnabled, openWallet, reconcileAll, sendWager } from './setup';
import { eventually } from '../support/eventually';

const wallets: string[] = [];
afterAll(async () => {
  if (e2eEnabled) await reconcileAll(wallets);
});

describe.skipIf(!e2eEnabled)('e2e: idempotency', () => {
  test('replay of the same request returns the same outcome flagged as a replay, one debit', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const cmd = wagerCommand(wallet, { money: brl('25.00') });
    const first = await submitWager(api, cmd);
    const replay = await submitWager(api, cmd);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false });
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  test('20 simultaneous copies of one request debit exactly once', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const cmd = wagerCommand(wallet, { money: brl('10.00') });
    const results = await Promise.all(Array.from({ length: 20 }, () => submitWager(api, cmd)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  test('same key with a different payload is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const cmd = wagerCommand(wallet, { money: brl('10.00') });
    await submitWager(api, cmd);
    const res = await submitWager(api, { ...cmd, money: brl('11.00') });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  test('same external transaction id under another key is 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const cmd = wagerCommand(wallet, { money: brl('10.00') });
    await submitWager(api, cmd);
    const res = await submitWager(api, { ...cmd, idempotencyKey: `key-${newId()}` });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'EXTERNAL_ID_CONFLICT' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  test('missing Idempotency-Key and invalid payloads are 400 and change nothing', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const { idempotencyKey, ...body } = wagerCommand(wallet);
    const noKey = await call(api, 'POST', '/wagering/transactions', { body });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
    const badAmount = await call(api, 'POST', '/wagering/transactions', {
      body: { ...body, money: { amount: '1.234', currency: 'BRL' } },
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.code).toBe('INVALID_PAYLOAD');
    const malformed = await call(api, 'POST', '/wagering/transactions', { body: '{"providerId":', headers: { 'idempotency-key': 'k' } });
    expect(malformed.status).toBe(400);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('the same operation delivered twice over SQS (distinct messages) and then over HTTP debits once', async () => {
    const wallet = await openWallet('100.00');
    wallets.push(wallet.id);
    const cmd = wagerCommand(wallet, { money: brl('10.00') });
    // Same envelope messageId, different SQS dedup ids → both reach the consumers (inbox dedup).
    const messageId = newId();
    await sendWager(cmd, { messageId, deduplicationId: `${messageId}-a` });
    await sendWager(cmd, { messageId, deduplicationId: `${messageId}-b` });
    // A fresh message carrying the same business key (another producer retry).
    await sendWager(cmd);
    await eventually(async () => expect(await balanceOf(wallet.id)).toBe('90.00'), { timeoutMs: 30_000 });

    const replay = await submitWager(api, cmd);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: brl('90.00') });

    // Let any straggling duplicate settle, then verify nothing moved and nothing was dead-lettered for us.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await balanceOf(wallet.id)).toBe('90.00');
    const entries = await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=50`);
    expect(entries.body.items).toHaveLength(2);
  });
});
