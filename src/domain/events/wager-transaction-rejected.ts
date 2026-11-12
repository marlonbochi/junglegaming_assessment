import type { Money } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { InvalidTransactionStateError } from '../shared/invalid-transaction-state.error';
import { IntegrationEvent, type EventContext } from './integration-event';
import { wagerTransactionData, type WagerTransactionEventData } from './wager-transaction-data';

export type WagerTransactionRejectedData = WagerTransactionEventData & { failureCode: string };

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1;

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionRejected {
    if (tx.failureCode === undefined) {
      throw new InvalidTransactionStateError(`Transaction ${tx.id} has no failureCode`);
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: { ...wagerTransactionData(tx, balance), failureCode: tx.failureCode },
    });
  }
}
