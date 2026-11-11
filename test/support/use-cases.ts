import type { WagerCommand } from '../../src/application/commands/wager-command';
import type { Clock } from '../../src/application/ports/clock';
import { noopMetrics, type Metrics } from '../../src/application/ports/metrics';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.types';
import { newId } from './persistence';

/** A clock that stays put until the test moves it. */
export function fixedClock(at: Date = new Date('2026-11-11T12:00:00.000Z')): Clock & { set(d: Date): void } {
  let current = at;
  return {
    now: () => current,
    set: (d: Date) => {
      current = d;
    },
  };
}

export type MetricCall = [name: keyof Metrics, ...args: unknown[]];

/** Metrics that remember every call, in order. */
export function recordingMetrics(): Metrics & { calls: MetricCall[]; named(name: keyof Metrics): unknown[][] } {
  const calls: MetricCall[] = [];
  const metrics = { ...noopMetrics } as Metrics;
  for (const name of Object.keys(noopMetrics) as Array<keyof Metrics>) {
    (metrics[name] as (...args: unknown[]) => void) = (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  }
  return Object.assign(metrics, {
    calls,
    named: (name: keyof Metrics) => calls.filter(([n]) => n === name).map(([, ...args]) => args),
  });
}

export interface WalletRef {
  id: string;
  playerId: string;
}

/** A BET of 10.00 BRL on `wallet` with fresh external id and idempotency key, unless overridden. */
export function wagerCommand(wallet: WalletRef, overrides: Partial<WagerCommand> = {}): WagerCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${newId()}`,
    idempotencyKey: `key-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}
