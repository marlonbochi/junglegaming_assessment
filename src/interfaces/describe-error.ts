/** One-line error description for logs: name, message and the direct cause. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (cause: ${e.cause.name}: ${e.cause.message})` : '';
  return `${e.name}: ${e.message}${cause}`;
}
