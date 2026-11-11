import { expect, test } from 'bun:test';
import { concurrencySuite } from '../support/concurrency';
import { openWalletVia, submitWager } from '../support/http';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { spawnService, withServiceLogs } from '../support/processes';
import { wagerCommand } from '../support/use-cases';

const suite = concurrencySuite('c01');

test(
  'scenario 1: the same BET 50× in parallel against a real api process → 1 debit, 49 idempotent replays',
  withServiceLogs(async () => {
    const api = await spawnService('api', suite.env());
    const wallet = await openWalletVia(api, '100.00');
    const bet = wagerCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const results = await Promise.all(Array.from({ length: 50 }, () => submitWager(api, bet)));

    expect(results.map((r) => r.status)).toEqual(Array(50).fill(200));
    const originals = results.filter((r) => r.body.idempotentReplay === false);
    const replays = results.filter((r) => r.body.idempotentReplay === true);
    expect(originals).toHaveLength(1);
    expect(replays).toHaveLength(49);
    const original = originals[0]!;
    expect(original.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(original.headers.get('idempotent-replayed')).toBeNull();
    for (const replay of replays) {
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    }

    expect(await suite.wagers(wallet.id)).toEqual([
      { id: original.body.transactionId, kind: 'BET', status: 'PROCESSED', failure_code: null },
    ]);
    expect(await suite.debits(wallet.id)).toBe(1);
    expect(await suite.balance(wallet.id)).toBe('75.00');
    await assertLedgerConsistency(suite.db.sql);
  }),
);
