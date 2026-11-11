import { defineEntity, p } from '@mikro-orm/core';
import { MoneyAmountType } from '../money-amount.type';

export const WalletSchema = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().columnType('char(3)'),
    balance: p.type(MoneyAmountType),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export class WalletRecord extends WalletSchema.class {}
WalletSchema.setClass(WalletRecord);
