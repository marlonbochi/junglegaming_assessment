/** What logs may say about an error: its name plus SQLSTATE / socket code and constraint. */
export interface ErrorSummary {
  type: string;
  code?: string;
  constraint?: string;
}

/**
 * Never the message: driver and trigger messages can embed row values such as balances (constitution #29).
 * `code` and `constraint` are copied by MikroORM's `DriverException` from the `pg` error.
 */
export function summarizeError(e: unknown): ErrorSummary {
  if (!(e instanceof Error)) return { type: typeof e };
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  return {
    type: e.name,
    ...(typeof code === 'string' && code ? { code } : {}),
    ...(typeof constraint === 'string' && constraint ? { constraint } : {}),
  };
}
