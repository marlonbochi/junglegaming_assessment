import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request (or per-message) fields every log line carries (constitution #29). */
export interface RequestContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Adds fields to the current context, once they are known; a no-op outside a request. */
export function enrichRequestContext(fields: Partial<Omit<RequestContext, 'correlationId'>>): void {
  const store = requestContext.getStore();
  if (store) Object.assign(store, fields);
}
