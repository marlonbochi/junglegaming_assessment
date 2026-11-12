import { summarizeError } from '../application/error-summary';

/**
 * One-line error description for logs: name and message of the error, and the direct cause by name,
 * SQLSTATE and constraint only (driver and trigger messages can embed amounts, constitution #29).
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return `${e.name}: ${e.message}${e.cause instanceof Error ? ` (cause: ${causeLabel(e.cause)})` : ''}`;
}

function causeLabel(cause: Error): string {
  const { type, code, constraint } = summarizeError(cause);
  return [type, code && `code=${code}`, constraint && `constraint=${constraint}`].filter(Boolean).join(' ');
}
