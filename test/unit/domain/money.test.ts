import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/money/money.errors';

describe('Money.from', () => {
  test.each(['0.00', '25.00', '999999999999999999.99'])('accepts %s', (a) =>
    expect(Money.from({ amount: a, currency: 'BRL' }).toJSON()).toEqual({ amount: a, currency: 'BRL' }));
  test.each(['', 'NaN', 'Infinity', '1e3', '25', '25.0', '1.234', '-1.00', '+1.00', '01.00', ' 25.00', '25.00 ',
             '٢٥.٠٠', '1000000000000000000.00', '25,00'])('rejects %p', (a) =>
    expect(() => Money.from({ amount: a, currency: 'BRL' })).toThrow(InvalidMoneyError));
  test.each(['brl', 'BR', 'BRLL', '', '12A'])('rejects currency %p', (c) =>
    expect(() => Money.from({ amount: '1.00', currency: c })).toThrow(InvalidMoneyError));
});

test('arithmetic is exact and immutable', () => {
  const a = Money.from({ amount: '0.10', currency: 'BRL' }), b = Money.from({ amount: '0.20', currency: 'BRL' });
  expect(a.add(b).toJSON().amount).toBe('0.30');
  expect(a.toJSON().amount).toBe('0.10');
  expect(a.subtract(b).isNegative()).toBe(true);
  expect(a.subtract(b).toJSON().amount).toBe('-0.10');
  expect(a.negate().negate().equals(a)).toBe(true);
});

test('currency mismatch throws', () => {
  expect(() => Money.zero('BRL').add(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  expect(() => Money.zero('BRL').isLessThan(Money.zero('USD'))).toThrow(CurrencyMismatchError);
});

test('storage limit', () => {
  const max = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
  expect(max.exceedsStorageLimit()).toBe(false);
  expect(max.add(Money.from({ amount: '0.01', currency: 'BRL' })).exceedsStorageLimit()).toBe(true);
});

test('toString', () => expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00 BRL'));

test('predicates, minor units and zero', () => {
  const z = Money.zero('BRL');
  expect(z.isZero()).toBe(true);
  expect(z.isPositive()).toBe(false);
  expect(Money.fromMinorUnits(2500n, 'BRL').minorUnits).toBe(2500n);
  expect(Money.fromMinorUnits(5n, 'BRL').toJSON().amount).toBe('0.05');
  expect(Money.fromMinorUnits(-5n, 'BRL').exceedsStorageLimit()).toBe(false);
  expect(() => Money.fromMinorUnits(1n, 'xx')).toThrow(InvalidMoneyError);
  expect(Money.zero('BRL').isLessThan(Money.fromMinorUnits(1n, 'BRL'))).toBe(true);
  expect(Money.zero('BRL').equals(Money.zero('USD'))).toBe(false);
});
