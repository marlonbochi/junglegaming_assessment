export type PgErrorClass = 'unique_violation' | 'lock_timeout' | 'transient' | 'other';

/** Deadlock (40P01) and serialization failure (40001) roll the whole transaction back, so a retry is safe. */
const TRANSIENT_SQLSTATES = ['57014', '53300', '57P01', '40P01', '40001'];
/** Socket and DNS failures: the database cannot be reached right now (e.g. a stopped container drops its DNS name). */
const SOCKET_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'];
const TRANSIENT_CODES = new Set([...TRANSIENT_SQLSTATES, ...SOCKET_CODES]);
/** SQLSTATE class 08: connection exception. */
const CONNECTION_EXCEPTION = /^08[0-9A-Z]{3}$/;
/** `pg` / `pg-pool` raise these without a code when a connection drops or cannot be established in time. */
const CODELESS_CONNECTION_FAILURE = /Connection terminated|not queryable|timeout exceeded when trying to connect/;
const MAX_CAUSE_DEPTH = 5;

/**
 * Classifies a database failure by its SQLSTATE / socket error code (or, for `pg`'s code-less connection
 * errors, by message), following `.cause`. Works on raw `pg` errors and on MikroORM's `DriverException`
 * wrappers, which copy `code` and `constraint` from the driver error.
 * Trigger and CHECK violations (23000, 23514, 23503) are programming errors and stay `other`.
 */
export function classifyPgError(e: unknown): PgErrorClass {
  for (let current = e, depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === '23505') return 'unique_violation';
    if (code === '55P03') return 'lock_timeout';
    if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || CONNECTION_EXCEPTION.test(code))) return 'transient';
    if (code === undefined && CODELESS_CONNECTION_FAILURE.test(current.message)) return 'transient';
    current = current.cause;
  }
  return 'other';
}

/** Name of the violated unique constraint or index. */
export function uniqueConstraintName(e: unknown): string {
  const constraint = (e as { constraint?: unknown } | undefined)?.constraint;
  if (typeof constraint === 'string' && constraint) return constraint;
  const match = e instanceof Error ? /unique constraint "([^"]+)"/.exec(e.message) : null;
  return match?.[1] ?? 'unknown';
}
