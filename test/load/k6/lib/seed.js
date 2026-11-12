import { SharedArray } from 'k6/data';

/**
 * Wallets opened by `test/load/run.ts` through `POST /wallets` before k6 starts (it reconciles them
 * all afterwards). `WALLETS_FILE` is a JSON array of `{ id, playerId }`, shared read-only by every VU.
 */
export const wallets = new SharedArray('wallets', () => JSON.parse(open(__ENV.WALLETS_FILE)));
