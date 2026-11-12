import { expect, test } from 'bun:test';
import { concurrencySuite } from '../support/concurrency';
import { call, openWalletVia, submitWager } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { spawnServices, withServiceLogs } from '../support/processes';
import { wagerCommand } from '../support/use-cases';

const suite = concurrencySuite('c02');
/** Independent races run at once, so the two BETs of each one really meet inside the database. */
const RACES = 20;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

test(
  'scenario 2: 100.00 − 80.00 − 80.00 from two api processes → 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, balance 20.00, 1 debit',
  withServiceLogs(async () => {
    const [a, b] = await spawnServices('api', 2, suite.env());
    const wallets = await Promise.all(Array.from({ length: RACES }, () => openWalletVia(a!, '100.00')));
    // Warm both processes' connection pools so neither side starts late.
    await Promise.all([a!, b!].map((api) => call(api, 'GET', `/wallets/${wallets[0]!.id}`)));

    const races = wallets.map((wallet) => ({
      wallet,
      bets: [wagerCommand(wallet, { money: brl('80.00') }), wagerCommand(wallet, { money: brl('80.00') })] as const,
    }));
    const firstRound = await Promise.all(races.map(({ bets }) => Promise.all([submitWager(a!, bets[0]), submitWager(b!, bets[1])])));

    for (const [i, { wallet }] of races.entries()) {
      const results = firstRound[i]!;
      const processed = results.filter((r) => r.status === 200);
      const rejected = results.filter((r) => r.status === 422);
      expect(processed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(processed[0]!.body).toMatchObject({ status: 'PROCESSED', balance: brl('20.00'), idempotentReplay: false });
      expect(rejected[0]!.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      const statuses = (await suite.wagers(wallet.id)).map((w) => [w.status, w.failure_code]).sort();
      expect(statuses).toEqual([
        ['PROCESSED', null],
        ['REJECTED', 'INSUFFICIENT_FUNDS'],
      ]);
      expect(await suite.balance(wallet.id)).toBe('20.00');
      expect(await suite.debits(wallet.id)).toBe(1);
    }

    // Resent crosswise: each process replays what the other one decided.
    const secondRound = await Promise.all(races.map(({ bets }) => Promise.all([submitWager(b!, bets[0]), submitWager(a!, bets[1])])));
    for (const [i, { wallet }] of races.entries()) {
      for (const [j, replay] of secondRound[i]!.entries()) {
        const original = firstRound[i]![j]!;
        expect(replay.status).toBe(original.status);
        expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
        expect(replay.headers.get('idempotent-replayed')).toBe('true');
      }
      expect(await suite.debits(wallet.id)).toBe(1);
      expect(await suite.balance(wallet.id)).toBe('20.00');
    }
    await assertLedgerConsistency(suite.db.sql);
  }),
);
