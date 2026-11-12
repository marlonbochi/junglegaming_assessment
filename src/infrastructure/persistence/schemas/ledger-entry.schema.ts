import { defineEntity, p } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/wallet/wallet-ledger-entry';
import { MoneyAmountType } from '../money-amount.type';

export const LedgerEntrySchema = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.enum(() => LedgerDirection).columnType('text'),
    amount: p.type(MoneyAmountType),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.type(MoneyAmountType),
    balanceAfter: p.type(MoneyAmountType),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});

export class LedgerEntryRecord extends LedgerEntrySchema.class {}
LedgerEntrySchema.setClass(LedgerEntryRecord);
