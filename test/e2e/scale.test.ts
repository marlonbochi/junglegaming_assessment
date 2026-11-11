import { afterAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually';
import { newId } from '../support/persistence';
import { submitWager } from '../support/http';
import { centsToText, planWagers, runPool, shuffle } from '../support/wager-load';
import { api, balanceOf, e2eEnabled, openWallet, reconcileAll, sendWager } from './setup';

const WALLETS = 10;
const OPS_PER_WALLET = 20;
const wallets: string[] = [];
afterAll(async () => {
  if (e2eEnabled) await reconcileAll(wallets);
});

describe.skipIf(!e2eEnabled)('e2e: burst across 3 consumers', () => {
  test('200 operations on 10 wallets (SQS + HTTP, with duplicates) end reconciled with the expected balances', async () => {
    const opened = await Promise.all(Array.from({ length: WALLETS }, () => openWallet('1000.00')));
    wallets.push(...opened.map((w) => w.id));
    const plan = planWagers(opened, OPS_PER_WALLET, 100_000n);
    expect(plan.ops).toHaveLength(WALLETS * OPS_PER_WALLET);

    const viaHttp = plan.ops.slice(0, 30);
    const viaSqs = plan.ops.slice(30);
    // Duplicates: SQS re-deliveries (same messageId, new dedup id), re-sends under a new messageId, HTTP replays.
    const sqsMessageIds = new Map(viaSqs.map((op) => [op.idempotencyKey, newId()]));
    const duplicates = shuffle(viaSqs).slice(0, 40);

    const httpStatuses: number[] = [];
    const sends: Array<() => Promise<unknown>> = [
      ...viaSqs.map((op) => () => sendWager(op, { messageId: sqsMessageIds.get(op.idempotencyKey)! })),
      ...duplicates.slice(0, 20).map((op) => () =>
        sendWager(op, { messageId: sqsMessageIds.get(op.idempotencyKey)!, deduplicationId: `dup-${newId()}` }),
      ),
      ...duplicates.slice(20).map((op) => () => sendWager(op)),
      ...viaHttp.map((op) => () => submitWager(api, op).then((r) => void httpStatuses.push(r.status))),
      ...viaHttp.slice(0, 10).map((op) => () => submitWager(api, op).then((r) => void httpStatuses.push(r.status))),
    ];
    const results = await runPool(shuffle(sends), 15);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(httpStatuses).toHaveLength(40);
    expect(httpStatuses.every((s) => s === 200 || s === 202)).toBe(true);

    await eventually(
      async () => {
        for (const wallet of opened) expect(await balanceOf(wallet.id)).toBe(centsToText(plan.expectedCents.get(wallet.id)!));
      },
      { timeoutMs: 90_000, intervalMs: 500 },
    );
    // Settled: a moment later nothing has moved (late duplicates are no-ops).
    await new Promise((r) => setTimeout(r, 3_000));
    for (const wallet of opened) expect(await balanceOf(wallet.id)).toBe(centsToText(plan.expectedCents.get(wallet.id)!));
  });
});
