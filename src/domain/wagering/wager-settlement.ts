import { FailureCode } from '../shared/failure-code';
import { InvalidTransactionStateError } from '../shared/invalid-transaction-state.error';
import { Wallet } from '../wallet/wallet';
import { BalanceLimitExceededError, InsufficientFundsError } from '../wallet/wallet.errors';
import { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.types';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

/** `none` = the transaction did not declare a reference. */
export type ReferenceLookup =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'found'; transaction: WagerTransaction; alreadyReversed: boolean };

export interface SettlementInput {
  tx: WagerTransaction;
  wallet: Wallet;
  reference: ReferenceLookup;
  ledgerEntryId: string;
  now: Date;
  pendingRetryAt: Date;
}

export type SettlementResult =
  | { outcome: 'PROCESSED'; ledgerEntry?: WalletLedgerEntry }
  | { outcome: 'REJECTED'; failureCode: FailureCode }
  | { outcome: 'PENDING_REFERENCE' };

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [Win]: [Bet],
  [Loss]: [Bet],
  [Refund]: [Bet],
  [Rollback]: [Bet, Win, Refund],
};

type ReferenceDecision = FailureCode | 'PENDING_REFERENCE' | undefined;

/** Applies one wager transaction to a wallet. The wallet is only mutated on PROCESSED. */
export function settle(input: SettlementInput): SettlementResult {
  const { tx, wallet, reference } = input;

  const identityFailure = checkIdentity(tx, wallet);
  if (identityFailure) return reject(input, identityFailure);

  if (reference.kind === 'none') {
    if (tx.requiresReference()) {
      throw new InvalidTransactionStateError(`${tx.kind} ${tx.id} was settled without a reference lookup`);
    }
    return apply(input, undefined);
  }

  if (reference.kind === 'missing') return pendReference(input);

  const decision = checkReference(tx, reference.transaction, reference.alreadyReversed);
  if (decision === 'PENDING_REFERENCE') return pendReference(input);
  if (decision) return reject(input, decision);
  return apply(input, reference.transaction);
}

function checkIdentity(tx: WagerTransaction, wallet: Wallet): FailureCode | undefined {
  if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) return FailureCode.PlayerWalletMismatch;
  if (tx.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}

/** Spec §4.5 reference validations 2–7, in order; the first failing one decides. */
function checkReference(tx: WagerTransaction, ref: WagerTransaction, alreadyReversed: boolean): ReferenceDecision {
  if (ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference) {
    return 'PENDING_REFERENCE';
  }
  if (ref.status === WagerTransactionStatus.Rejected || ref.status === WagerTransactionStatus.Failed) {
    return FailureCode.ReferenceNotReversible;
  }
  if (
    ref.providerId !== tx.providerId ||
    ref.playerId !== tx.playerId ||
    ref.walletId !== tx.walletId ||
    ref.money.currency !== tx.money.currency ||
    ref.roundId !== tx.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (!(ALLOWED_REFERENCE_KINDS[tx.kind] ?? []).includes(ref.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  const isReversal = tx.requiresReference();
  if (isReversal && !ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
  if (isReversal && alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  return undefined;
}

function apply(input: SettlementInput, reference: WagerTransaction | undefined): SettlementResult {
  const { tx, wallet, now } = input;
  const direction = tx.ledgerDirectionFor(reference);
  if (!direction) {
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { outcome: 'PROCESSED' };
  }

  const change = { money: tx.money, transactionId: tx.id, entryId: input.ledgerEntryId, now };
  let ledgerEntry: WalletLedgerEntry;
  try {
    ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(change) : wallet.credit(change);
  } catch (error) {
    const code = translateWalletError(tx, error);
    if (!code) throw error;
    return reject(input, code);
  }
  tx.markProcessed(reference?.id, wallet.balance, now);
  return { outcome: 'PROCESSED', ledgerEntry };
}

function translateWalletError(tx: WagerTransaction, error: unknown): FailureCode | undefined {
  if (error instanceof InsufficientFundsError) {
    return tx.kind === Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
  }
  if (error instanceof BalanceLimitExceededError) return FailureCode.BalanceLimitExceeded;
  return undefined;
}

function reject(input: SettlementInput, failureCode: FailureCode): SettlementResult {
  input.tx.reject(failureCode, input.wallet.balance, input.now);
  return { outcome: 'REJECTED', failureCode };
}

function pendReference(input: SettlementInput): SettlementResult {
  const { tx, pendingRetryAt, now } = input;
  if (tx.status === WagerTransactionStatus.PendingReference) tx.scheduleReferenceRetry(pendingRetryAt, now);
  else tx.markPendingReference(pendingRetryAt, now);
  return { outcome: 'PENDING_REFERENCE' };
}
