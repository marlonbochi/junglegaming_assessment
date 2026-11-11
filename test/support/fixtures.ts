import { Money } from '../../src/domain/money/money';
import {
  CreateWagerTransactionProps,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction.types';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const now = new Date('2026-11-11T00:00:00Z');

export type TxOverrides = Partial<Omit<CreateWagerTransactionProps, 'kind'>> & {
  kind?: `${WagerTransactionKind}`;
};

let sequence = 0;

/** Builds the input of `WagerTransaction.create` with unique ids and sensible defaults. */
export function txProps(overrides: TxOverrides = {}): CreateWagerTransactionProps {
  sequence += 1;
  return {
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `idem-${sequence}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    now,
    ...overrides,
  } as CreateWagerTransactionProps;
}

export const tx = (overrides: TxOverrides = {}): WagerTransaction => WagerTransaction.create(txProps(overrides));

export const bet = (overrides: Omit<TxOverrides, 'kind'> = {}): WagerTransaction =>
  tx({ ...overrides, kind: 'BET' });
