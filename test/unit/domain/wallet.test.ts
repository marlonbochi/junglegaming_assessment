import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/money/money.errors';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { BalanceLimitExceededError, InsufficientFundsError } from '../../../src/domain/wallet/wallet.errors';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T00:00:00Z');
const later = new Date('2026-11-11T01:00:00Z');
const open = (amount: string) =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), openingTransactionId: 't0', openingEntryId: 'e0', now });
const change = (money: Money, at = later) => ({ money, transactionId: 't1', entryId: 'e1', now: at });

describe('Wallet', () => {
  test('open with positive balance: version 1 and opening credit entry v1', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
  });

  test('open with zero balance: no entry, version 1', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('debit returns balanced entry, bumps version and updatedAt', () => {
    const { wallet } = open('100.00');
    const e = wallet.debit(change(brl('80.00')));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.walletVersion).toBe(2);
    expect(e.balanceBefore.toJSON().amount).toBe('100.00');
    expect(e.balanceAfter.toJSON().amount).toBe('20.00');
    expect(e.isBalanced()).toBe(true);
  });

  test('credit returns balanced entry, bumps version and updatedAt', () => {
    const { wallet } = open('10.00');
    const e = wallet.credit(change(brl('5.50')));
    expect(wallet.balance.toJSON().amount).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.walletVersion).toBe(2);
    expect(e.isBalanced()).toBe(true);
  });

  test('debit beyond balance throws and leaves state untouched', () => {
    const { wallet } = open('20.00');
    expect(() => wallet.debit(change(brl('80.00')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(now);
  });

  test('credit beyond storage limit throws BalanceLimitExceededError and leaves state untouched', () => {
    const { wallet } = open('999999999999999999.99');
    expect(() => wallet.credit(change(brl('0.01')))).toThrow(BalanceLimitExceededError);
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(now);
  });

  test('currency mismatch on credit leaves state untouched', () => {
    const { wallet } = open('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(change(usd))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(now);
  });

  test('currency mismatch on debit leaves state untouched', () => {
    const { wallet } = open('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(change(usd))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('debit with non-positive amount throws InvalidMoneyError', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.debit(change(brl('0.00')))).toThrow(InvalidMoneyError);
    expect(() => wallet.debit(change(brl('1.00').negate()))).toThrow(InvalidMoneyError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('credit with non-positive amount throws InvalidMoneyError', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.credit(change(brl('0.00')))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(change(brl('1.00').negate()))).toThrow(InvalidMoneyError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('open rejects negative initial balance', () =>
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('1.00').negate(),
        openingTransactionId: 't',
        openingEntryId: 'e',
        now,
      }),
    ).toThrow(InvalidMoneyError));

  test('toState and rehydrate round-trip', () => {
    const { wallet } = open('10.00');
    wallet.credit(change(brl('1.00')));
    const copy = Wallet.rehydrate(wallet.toState());
    expect(copy.toState()).toEqual(wallet.toState());
    expect(copy.currency).toBe('BRL');
    expect(copy.playerId).toBe('p1');
  });
});
