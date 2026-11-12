import { z } from 'zod';
import { lowercaseUuid, submitWagerBody } from '../http/schemas';

const messageId = z.string().min(1).max(255);

/** README §10: the HTTP submission body plus the idempotency key, which travels in `data`. */
export const wagerMessageSchema = z
  .object({
    messageId,
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: submitWagerBody.extend({ idempotencyKey: z.string().min(1).max(255) }).strict(),
  })
  .strict();

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

/** On failure, whatever is still readable: the envelope `messageId` and a uuid `walletId`. */
export type ParsedWagerMessage = { ok: true; message: WagerMessage } | { ok: false; messageId?: string; walletId?: string };

export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    return { ok: false };
  }
  const parsed = wagerMessageSchema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const readable = readableIds.safeParse(json);
  if (!readable.success) return { ok: false };
  const { messageId: id, data } = readable.data;
  return { ok: false, ...(id !== undefined ? { messageId: id } : {}), ...(data?.walletId !== undefined ? { walletId: data.walletId } : {}) };
}

const readableIds = z.object({
  messageId: messageId.optional().catch(undefined),
  data: z
    .object({ walletId: lowercaseUuid.optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
