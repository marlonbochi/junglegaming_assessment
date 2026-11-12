import { HttpException } from '@nestjs/common';
import {
  ApplicationError,
  ForbiddenProviderError,
  PermanentInfraError,
  TransientInfraError,
  UnauthenticatedError,
  type AppErrorCode,
} from '../../application/errors';

/** Auth codes are HTTP-only (spec §7/§9): they never reach the domain's FailureCode. */
export type ProblemCode = AppErrorCode | 'SERVICE_UNAVAILABLE' | 'INTERNAL_ERROR' | 'UNAUTHENTICATED' | 'PROVIDER_MISMATCH' | 'FORBIDDEN';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  retryable: boolean;
  correlationId: string;
  detail?: string;
  transactionId?: string;
}

export interface Problem {
  status: number;
  headers: Record<string, string>;
  body: ProblemBody;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** A replayed submission whose transaction was recorded FAILED: terminal, needs investigation (spec §7). */
export class FailedTransactionError extends Error {
  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} failed`);
    this.name = 'FailedTransactionError';
  }
}

const APPLICATION_STATUS: Record<AppErrorCode, number> = {
  INVALID_PAYLOAD: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_CURSOR: 400,
  WALLET_NOT_FOUND: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  EXTERNAL_ID_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  INBOX_PAYLOAD_MISMATCH: 409,
  NOT_FOUND: 404,
};

const TITLES: Record<ProblemCode, string> = {
  INVALID_PAYLOAD: 'Invalid payload',
  MISSING_IDEMPOTENCY_KEY: 'Missing or invalid Idempotency-Key header',
  INVALID_CURSOR: 'Invalid cursor',
  WALLET_NOT_FOUND: 'Wallet not found',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused with a different payload',
  EXTERNAL_ID_CONFLICT: 'External transaction id already used with another idempotency key',
  WALLET_ALREADY_EXISTS: 'Wallet already exists for this player and currency',
  INBOX_PAYLOAD_MISMATCH: 'Message id reused with a different payload',
  NOT_FOUND: 'Resource not found',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
  INTERNAL_ERROR: 'Internal error',
  UNAUTHENTICATED: 'Missing, invalid or expired bearer token',
  PROVIDER_MISMATCH: 'Caller may not act as this provider',
  FORBIDDEN: 'Forbidden',
};

/** Spec §7 mapping of every error to an RFC 9457 problem. Infrastructure messages never leak. */
export function toProblem(error: unknown, correlationId: string): Problem {
  const problem = (
    status: number,
    code: ProblemCode,
    retryable: boolean,
    extra: Partial<ProblemBody> = {},
    headers: Record<string, string> = {},
  ): Problem => ({
    status,
    headers,
    body: {
      type: `https://errors.wagering.local/${code.toLowerCase().replaceAll('_', '-')}`,
      title: TITLES[code],
      status,
      code,
      retryable,
      correlationId,
      ...extra,
    },
  });

  if (error instanceof ApplicationError) {
    return problem(APPLICATION_STATUS[error.code], error.code, false, error.message !== error.code ? { detail: error.message } : {});
  }
  if (error instanceof UnauthenticatedError) {
    return problem(401, 'UNAUTHENTICATED', false, { detail: error.message }, { 'WWW-Authenticate': 'Bearer' });
  }
  if (error instanceof ForbiddenProviderError) return problem(403, 'PROVIDER_MISMATCH', false, { detail: error.message });
  if (error instanceof FailedTransactionError) return problem(500, 'INTERNAL_ERROR', false, { transactionId: error.transactionId });
  if (error instanceof TransientInfraError) return problem(503, 'SERVICE_UNAVAILABLE', true, {}, { 'Retry-After': '1' });
  if (error instanceof PermanentInfraError) return problem(500, 'INTERNAL_ERROR', true);
  if (error instanceof HttpException) return fromHttpException(error, problem);
  return problem(500, 'INTERNAL_ERROR', true);
}

/** Nest's own exceptions: unknown routes, body-parser failures (malformed JSON, too large), guards. */
function fromHttpException(error: HttpException, problem: (status: number, code: ProblemCode, retryable: boolean) => Problem): Problem {
  const status = error.getStatus();
  if (status === 404) return problem(404, 'NOT_FOUND', false);
  if (status === 401) return problem(401, 'UNAUTHENTICATED', false);
  if (status === 403) return problem(403, 'FORBIDDEN', false);
  if (status >= 400 && status < 500) return problem(status, 'INVALID_PAYLOAD', false);
  return problem(500, 'INTERNAL_ERROR', true);
}
