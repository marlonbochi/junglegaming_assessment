import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.types';

/** Contract shape only: the amount stays a string and `Money` parses it in the use case. */
const money = z.object({ amount: z.string(), currency: z.string() }).strict();

const text = z.string().min(1).max(255);

/** A valid uuid, canonicalised to lowercase so spellings of one id compare and hash identically. */
export const lowercaseUuid = z.uuid().transform((value) => value.toLowerCase());

export const uuidParam = lowercaseUuid;
export const textParam = text;

/** Required on submissions; a missing or oversized key is MISSING_IDEMPOTENCY_KEY. */
export const idempotencyKeyHeader = z.string().min(1).max(255);

export const openWalletBody = z
  .object({
    playerId: lowercaseUuid,
    initialBalance: money,
  })
  .strict();

const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export const submitWagerBody = z
  .object({
    providerId: text,
    externalTransactionId: text,
    playerId: lowercaseUuid,
    walletId: lowercaseUuid,
    roundId: text,
    gameId: text,
    kind: z.enum(SUBMITTABLE_KINDS),
    money,
    referenceExternalTransactionId: text.optional(),
  })
  .strict();

export type SubmitWagerBody = z.infer<typeof submitWagerBody>;

export const ledgerQuery = z
  .object({
    cursor: z.string().min(1).optional(),
    // Range (1..200) is the use case's rule; here only "is an integer".
    limit: z
      .string()
      .regex(/^[0-9]{1,6}$/)
      .transform(Number)
      .optional(),
  })
  .strict();
