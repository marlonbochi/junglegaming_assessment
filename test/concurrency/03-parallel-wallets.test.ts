import { expect, test } from 'bun:test';
import { concurrencySuite } from '../support/concurrency';
import { eventually } from '../support/eventually';
import { openWalletVia, submitWager, type HttpTarget } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { spawnService, spawnServices, withServiceLogs } from '../support/processes';
import { wagerCommand, type WalletRef } from '../support/use-cases';

const suite = concurrencySuite('c03');
const WALLETS = 20;
const BETS_PER_WALLET = 25;
const oneReal = { money: { amount: '1.00', currency: 'BRL' } };

/** Sends one 1.00 BET per entry of `plan`, all at once, spread over `apis`; returns the wall time. */
async function timedBets(apis: HttpTarget[], plan: WalletRef[]): Promise<number> {
  const started = performance.now();
  const results = await Promise.all(plan.map((wallet, i) => submitWager(apis[i % apis.length]!, wagerCommand(wallet, oneReal))));
  const elapsed = performance.now() - started;
  expect(results.filter((r) => r.status !== 200)).toEqual([]);
  return elapsed;
}

test(
  'scenario 3: a transaction waiting on one wallet lock does not hold back transactions on other wallets',
  withServiceLogs(async () => {
    const api = await spawnService('api', suite.env());
    const [blocked, ...others] = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(api, '100.00')));

    // An external transaction holds wallet `blocked`'s row lock, like a long in-flight settlement would.
    const holder = await suite.db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wallets WHERE id = ${blocked!.id} FOR UPDATE`;
      let blockedSettled = false;
      const blockedBet = submitWager(api, wagerCommand(blocked!, oneReal)).finally(() => {
        blockedSettled = true;
      });
      await eventually(async () => {
        const waiting = await suite.db.sql`
          SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`;
        expect(waiting[0].n).toBeGreaterThanOrEqual(1);
      });

      const results = await Promise.all(
        others.flatMap((wallet) => Array.from({ length: 5 }, () => submitWager(api, wagerCommand(wallet, oneReal)))),
      );
      expect(results.map((r) => r.status)).toEqual(Array(results.length).fill(200));
      expect(blockedSettled).toBe(false);
      for (const wallet of others) expect(await suite.balance(wallet.id)).toBe('95.00');

      await holder`ROLLBACK`;
      const released = await blockedBet;
      expect(released.status).toBe(200);
      expect(released.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '99.00', currency: 'BRL' } });
    } finally {
      holder.release();
    }
    await assertLedgerConsistency(suite.db.sql);
  }),
);

test(
  `scenario 3: ${WALLETS} wallets × ${BETS_PER_WALLET} BETs finish in under half the time of ${WALLETS * BETS_PER_WALLET} BETs on one hot wallet`,
  withServiceLogs(async () => {
    const apis = await spawnServices('api', 3, suite.env());
    const hot = await openWalletVia(apis[0]!, '1000.00');
    const spread = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(apis[0]!, '1000.00')));
    // Warm-up, so neither measurement pays for JIT and connection pools.
    await timedBets(apis, spread.slice(0, 10).flatMap((w) => [w, w, w]));

    const hotMs = await timedBets(apis, Array(WALLETS * BETS_PER_WALLET).fill(hot));
    const spreadMs = await timedBets(apis, spread.flatMap((w) => Array(BETS_PER_WALLET).fill(w)));

    expect(spreadMs).toBeLessThan(0.5 * hotMs);
    expect(await suite.balance(hot.id)).toBe('500.00');
    for (const [i, wallet] of spread.entries()) {
      const warmUpBets = i < 10 ? 3 : 0;
      expect(await suite.balance(wallet.id)).toBe(`${1000 - BETS_PER_WALLET - warmUpBets}.00`);
    }
    await assertLedgerConsistency(suite.db.sql);
  }),
);
