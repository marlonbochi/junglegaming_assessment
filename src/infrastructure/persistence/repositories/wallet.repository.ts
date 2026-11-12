import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { walletToDomain, walletToRecord } from '../mappers/wallet.mapper';
import { WalletSchema } from '../schemas/wallet.schema';
import { assertSingleRow, FRESH } from './read-options';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletSchema, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? walletToDomain(r) : undefined;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletSchema, { id }, FRESH);
    return r ? walletToDomain(r) : undefined;
  }

  async insert(w: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRecord(w));
  }

  async update(w: Wallet): Promise<void> {
    const { id, ...changes } = walletToRecord(w);
    assertSingleRow(await this.em.nativeUpdate(WalletSchema, { id }, changes), `wallet ${id}`);
  }
}
