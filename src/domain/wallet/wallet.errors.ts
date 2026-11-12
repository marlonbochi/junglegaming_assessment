import { DomainError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class BalanceLimitExceededError extends DomainError {
  readonly code = 'BALANCE_LIMIT_EXCEEDED';
}
