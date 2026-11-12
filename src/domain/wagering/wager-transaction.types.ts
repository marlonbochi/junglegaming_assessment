import { Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
  now: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  /** Undefined only for OPENING. */
  roundId: string | undefined;
  /** Undefined only for OPENING. */
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class MissingReferenceError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

export class UnexpectedReferenceError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

export class OpeningNotAllowedError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}
