import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction.types';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export type SubmissionSource = { type: 'http' } | { type: 'sqs'; consumerName: string; messageId: string };
