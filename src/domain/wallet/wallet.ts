import { Money } from '../money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../money/money.errors';
import { BalanceLimitExceededError, InsufficientFundsError } from './wallet.errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceChange {
  money: Money;
  transactionId: string;
  entryId: string;
  now: Date;
}

export interface OpenWalletParams {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(s: WalletState) {
    this.id = s.id;
    this.playerId = s.playerId;
    this.currency = s.currency;
    this.createdAt = s.createdAt;
    this._balance = s.balance;
    this._version = s.version;
    this._updatedAt = s.updatedAt;
  }

  static open(p: OpenWalletParams): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (p.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance must not be negative');
    }
    const wallet = new Wallet({
      id: p.id,
      playerId: p.playerId,
      currency: p.initialBalance.currency,
      balance: p.initialBalance,
      version: 1,
      createdAt: p.now,
      updatedAt: p.now,
    });
    if (p.initialBalance.isZero()) return { wallet };
    const openingEntry = WalletLedgerEntry.create({
      id: p.openingEntryId,
      walletId: p.id,
      transactionId: p.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: p.initialBalance,
      balanceBefore: Money.zero(p.initialBalance.currency),
      balanceAfter: p.initialBalance,
      walletVersion: 1,
      createdAt: p.now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(c: BalanceChange): WalletLedgerEntry {
    this.assertValidChange(c.money);
    if (this._balance.isLessThan(c.money)) {
      throw new InsufficientFundsError(`Insufficient funds: balance ${this._balance}, debit ${c.money}`);
    }
    return this.apply(c, LedgerDirection.Debit, this._balance.subtract(c.money));
  }

  credit(c: BalanceChange): WalletLedgerEntry {
    this.assertValidChange(c.money);
    const after = this._balance.add(c.money);
    if (after.exceedsStorageLimit()) {
      throw new BalanceLimitExceededError(`Balance limit exceeded by credit of ${c.money}`);
    }
    return this.apply(c, LedgerDirection.Credit, after);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertValidChange(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: wallet ${this.currency} vs ${money.currency}`);
    }
    if (!money.isPositive()) {
      throw new InvalidMoneyError('Amount must be positive');
    }
  }

  /** Builds (and validates) the entry first so that state is only mutated on success. */
  private apply(c: BalanceChange, direction: LedgerDirection, after: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: c.entryId,
      walletId: this.id,
      transactionId: c.transactionId,
      direction,
      money: c.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: c.now,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = c.now;
    return entry;
  }
}
