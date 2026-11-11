import type { MoneyProps } from '../../domain/money/money';
import { ApplicationError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(id: string): Promise<WalletView> {
    const wallet = await this.uow.run((r) => r.wallets.findById(id));
    if (!wallet) throw new ApplicationError('NOT_FOUND', `Wallet ${id} not found`);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
