import { describe, expect, test } from 'bun:test';
import { MoneyAmountType } from '../../../src/infrastructure/persistence/money-amount.type';

describe('MoneyAmountType', () => {
  const type = new MoneyAmountType();

  test('keeps amounts as strings both ways', () => {
    expect(type.convertToDatabaseValue('1000.00')).toBe('1000.00');
    expect(type.convertToJSValue('99999999999999999.99')).toBe('99999999999999999.99');
  });

  test('rejects anything the driver returns that is not a string', () => {
    expect(() => type.convertToJSValue(10 as unknown as string)).toThrow(/string/);
    expect(() => type.convertToJSValue(10n as unknown as string)).toThrow(/string/);
  });

  test('maps to numeric(20,2)', () => {
    expect(type.getColumnType()).toBe('numeric(20,2)');
  });
});
