import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import {
  LedgerDirection,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const base = { id: 'e1', walletId: 'w1', transactionId: 't1', walletVersion: 2, createdAt: new Date(0) };

describe('WalletLedgerEntry', () => {
  test('debit entry balanced', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('80.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('20.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test('credit entry with wrong arithmetic throws', () =>
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('9.99'),
      }),
    ).toThrow(UnbalancedLedgerEntryError));

  test('zero amount throws', () =>
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError));

  test('negative balanceAfter throws', () =>
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').negate(),
      }),
    ).toThrow(UnbalancedLedgerEntryError));

  test('mixed currencies throw', () =>
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow());

  test('rehydrate does not validate', () =>
    expect(
      WalletLedgerEntry.rehydrate({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('5.00'),
      }).isBalanced(),
    ).toBe(false));

  test('is structurally immutable', () => {
    const state = {
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    };
    expect(Object.isFrozen(WalletLedgerEntry.create(state))).toBe(true);
    expect(Object.isFrozen(WalletLedgerEntry.rehydrate(state))).toBe(true);
  });
});
