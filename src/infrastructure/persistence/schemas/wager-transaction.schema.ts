import { defineEntity, p } from '@mikro-orm/core';
import { FailureCode } from '../../../domain/shared/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-transaction.types';
import { MoneyAmountType } from '../money-amount.type';

export const WagerTransactionSchema = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string().columnType('char(64)'),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text().nullable(),
    gameId: p.text().nullable(),
    kind: p.enum(() => WagerTransactionKind).columnType('text'),
    amount: p.type(MoneyAmountType),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.enum(() => WagerTransactionStatus).columnType('text'),
    failureCode: p.enum(() => FailureCode).columnType('text').nullable(),
    observedBalance: p.type(MoneyAmountType).nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    processedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export class WagerTransactionRecord extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionRecord);
