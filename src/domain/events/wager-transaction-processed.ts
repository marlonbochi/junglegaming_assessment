import type { Money } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { wagerTransactionData, type WagerTransactionEventData } from './wager-transaction-data';

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1;

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: wagerTransactionData(tx, balance),
    });
  }
}
