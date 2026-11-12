import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  insert(w: Wallet): Promise<void>;
  update(w: Wallet): Promise<void>;
}
