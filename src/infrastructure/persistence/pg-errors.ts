export type PgErrorClass = 'unique_violation' | 'lock_timeout' | 'transient' | 'other';

const TRANSIENT_CODES = new Set(['57014', '53300', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
/** SQLSTATE class 08: connection exception. */
const CONNECTION_EXCEPTION = /^08[0-9A-Z]{3}$/;
const MAX_CAUSE_DEPTH = 5;

/**
 * Classifies a database failure by its SQLSTATE / socket error code. Works on raw `pg` errors and on
 * MikroORM's `DriverException` wrappers, which copy `code` and `constraint` from the driver error.
 * Trigger and CHECK violations (23000, 23514, 23503) are programming errors and stay `other`.
 */
export function classifyPgError(e: unknown): PgErrorClass {
  for (let current = e, depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === '23505') return 'unique_violation';
    if (code === '55P03') return 'lock_timeout';
    if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || CONNECTION_EXCEPTION.test(code))) return 'transient';
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
