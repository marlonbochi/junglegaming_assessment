import type { WagerTransaction } from '../wagering/wager-transaction';
import { InvalidTransactionStateError } from '../shared/invalid-transaction-state.error';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.nextAttemptAt === undefined || tx.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`Transaction ${tx.id} is not awaiting a reference`);
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextAttemptAt.toISOString(),
      },
    });
  }
}
