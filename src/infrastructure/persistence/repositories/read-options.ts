/**
 * Writes go straight to SQL (`insert` / `nativeUpdate`), bypassing the identity map, so every read
 * must hit the database too or it could return a stale copy loaded earlier in the transaction.
 */
export const FRESH = { disableIdentityMap: true } as const;

/** Throws unless exactly one row was written; anything else means the aggregate was never persisted. */
export function assertSingleRow(affected: number, what: string): void {
  if (affected !== 1) throw new Error(`Expected to update 1 row of ${what}, updated ${affected}`);
}
