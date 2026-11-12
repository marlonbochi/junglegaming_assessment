import type { WagerCommand } from '../../src/application/commands/wager-command';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.types';
import { newId } from './persistence';
import { wagerCommand, type WalletRef } from './use-cases';

export interface WagerPlan {
  /** Every distinct operation, in an order where references may arrive after their dependants. */
  ops: WagerCommand[];
  /** Balance of each wallet (minor units) once every op is PROCESSED. */
  expectedCents: Map<string, bigint>;
}

const { Win, Loss, Refund, Rollback } = WagerTransactionKind;
/** What follows a BET in its round; `undefined` = nothing. */
const FOLLOW_UPS = [Win, Loss, Refund, Rollback, undefined] as const;

/** For indexes and coin flips only; money comes from `randomCents`. */
const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
/** A random amount in minor units, as bigint from the start (constitution #1: never `number`, not even in tests). */
function randomCents(min: bigint, max: bigint): bigint {
  const [word] = crypto.getRandomValues(new BigUint64Array(1));
  return min + word! % (max - min + 1n);
}
const amountOf = (cents: bigint) => ({ amount: centsToText(cents), currency: 'BRL' });

/**
 * Valid wagering flows on each wallet: rounds of a BET followed by a WIN, LOSS, REFUND or ROLLBACK of
 * it (or nothing), plus standalone WINs. With balances far above the amounts, every op is PROCESSED,
 * so the final balances are known up front. The ops come back shuffled.
 */
export function planWagers(wallets: WalletRef[], opsPerWallet: number, openingCents: bigint): WagerPlan {
  const ops: WagerCommand[] = [];
  const expectedCents = new Map<string, bigint>();
  for (const wallet of wallets) {
    let balance = openingCents;
    let count = 0;
    while (count < opsPerWallet) {
      const roundId = `round-${newId()}`;
      const betCents = randomCents(100n, 5_000n);
      const bet = wagerCommand(wallet, { roundId, money: amountOf(betCents) });
      ops.push(bet);
      balance -= betCents;
      count += 1;
      const kind = FOLLOW_UPS[randomInt(0, FOLLOW_UPS.length - 1)];
      if (kind === undefined || count >= opsPerWallet) continue;
      const winCents = randomCents(100n, 10_000n);
      const money = kind === Win ? amountOf(winCents) : bet.money;
      ops.push(wagerCommand(wallet, { roundId, kind, money, referenceExternalTransactionId: bet.externalTransactionId }));
      if (kind === Win) balance += winCents;
      if (kind === Refund || kind === Rollback) balance += betCents;
      count += 1;
      if (count < opsPerWallet && randomInt(0, 4) === 0) {
        const standaloneCents = randomCents(100n, 2_000n);
        ops.push(wagerCommand(wallet, { kind: Win, money: amountOf(standaloneCents) }));
        balance += standaloneCents;
        count += 1;
      }
    }
    expectedCents.set(wallet.id, balance);
  }
  return { ops: shuffle(ops), expectedCents };
}

/** `cents` as the `numeric(20,2)` text Postgres returns. */
export function centsToText(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Runs `tasks` with at most `concurrency` in flight; settles every task, in order. */
export async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]!() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, lane));
  return results;
}
