/** Programming error: an illegal transaction state transition. Deliberately not a DomainError. */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
