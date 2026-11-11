import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Maximum value of numeric(20,2), in minor units. */
export const MONEY_MAX_MINOR_UNITS = 99_999_999_999_999_999_999n;

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,17})\.([0-9]{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly units: bigint,
    readonly currency: string,
  ) {}

  static from(p: MoneyProps): Money {
    Money.assertCurrency(p.currency);
    const match = typeof p.amount === 'string' ? AMOUNT_PATTERN.exec(p.amount) : null;
    if (!match) throw new InvalidMoneyError(`Invalid money amount: ${String(p.amount)}`);
    return new Money(BigInt(`${match[1]}${match[2]}`), p.currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  static fromMinorUnits(units: bigint, currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(units, currency);
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
    }
  }

  get minorUnits(): bigint {
    return this.units;
  }

  add(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.units + o.units, this.currency);
  }

  subtract(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.units - o.units, this.currency);
  }

  negate(): Money {
    return new Money(-this.units, this.currency);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isLessThan(o: Money): boolean {
    this.assertSameCurrency(o);
    return this.units < o.units;
  }

  equals(o: Money): boolean {
    return this.currency === o.currency && this.units === o.units;
  }

  exceedsStorageLimit(): boolean {
    const abs = this.units < 0n ? -this.units : this.units;
    return abs > MONEY_MAX_MINOR_UNITS;
  }

  toJSON(): MoneyProps {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(3, '0');
    const amount = `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
    return { amount, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(o: Money): void {
    if (this.currency !== o.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${o.currency}`);
    }
  }
}
