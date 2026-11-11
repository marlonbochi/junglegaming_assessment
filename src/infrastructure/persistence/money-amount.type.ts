import { Type } from '@mikro-orm/core';

/**
 * `numeric(20,2)` kept as a decimal string end to end: never a JS `number`, so no precision is lost.
 * The `pg` driver returns numerics as strings; anything else means a misconfigured driver and fails loudly.
 */
export class MoneyAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    return value;
  }

  override convertToJSValue(value: string): string {
    if (typeof value !== 'string') {
      throw new TypeError(`Expected numeric(20,2) as a string from the driver, got ${typeof value}`);
    }
    return value;
  }

  override getColumnType(): string {
    return 'numeric(20,2)';
  }

  override compareAsType(): string {
    return 'string';
  }
}
