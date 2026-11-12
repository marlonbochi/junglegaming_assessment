export type AppErrorCode =
  | 'INVALID_PAYLOAD'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'EXTERNAL_ID_CONFLICT'
  | 'INBOX_PAYLOAD_MISMATCH'
  | 'NOT_FOUND'
  | 'INVALID_CURSOR';

export class ApplicationError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApplicationError';
  }
}

/** Infrastructure failure worth retrying. */
export class TransientInfraError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientInfraError';
  }
}

/** Infrastructure failure that retrying will not fix. */
export class PermanentInfraError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentInfraError';
  }
}

/** A unique constraint or index rejected the write; `constraint` names it. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string,
    message?: string,
  ) {
    super(message ?? `Unique constraint violated: ${constraint}`);
    this.name = 'UniqueViolationError';
  }
}

/** The caller presented no usable credentials: no, malformed, invalid, expired or wrong-audience token (→ 401). */
export class UnauthenticatedError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** The authenticated caller tried to act as another provider (→ 403 PROVIDER_MISMATCH). */
export class ForbiddenProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`Caller may not act as provider ${providerId}`);
    this.name = 'ForbiddenProviderError';
  }
}
