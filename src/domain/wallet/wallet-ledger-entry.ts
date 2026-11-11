import { Money } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class UnbalancedLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedLedgerEntryError';
  }
}

export class WalletLedgerEntry implements LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(s: LedgerEntryState) {
    this.id = s.id;
    this.walletId = s.walletId;
    this.transactionId = s.transactionId;
    this.direction = s.direction;
    this.money = s.money;
    this.balanceBefore = s.balanceBefore;
    this.balanceAfter = s.balanceAfter;
    this.walletVersion = s.walletVersion;
    this.createdAt = s.createdAt;
    Object.freeze(this);
  }

  /** Validates the entry invariants; use for new entries. */
  static create(p: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(p);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(`Ledger entry ${p.id} is not balanced`);
    }
    return entry;
  }

  /** Rebuilds a persisted entry without validation. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s);
  }

  isBalanced(): boolean {
    const { money, balanceBefore, balanceAfter } = this;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) return false;
    if (!money.isPositive() || balanceAfter.isNegative()) return false;
    const expected =
      this.direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    return expected.equals(balanceAfter);
  }
}
