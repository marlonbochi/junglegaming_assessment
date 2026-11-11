import type { WagerCommand } from '../commands/wager-command';
import { canonicalJson } from './canonical-json';

/** sha256 over the business fields only; the idempotency key is deliberately excluded. */
export function payloadHash(cmd: WagerCommand): string {
  const business = {
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: { amount: cmd.money.amount, currency: cmd.money.currency },
    referenceExternalTransactionId: cmd.referenceExternalTransactionId,
  };
  return new Bun.CryptoHasher('sha256').update(canonicalJson(business)).digest('hex');
}
