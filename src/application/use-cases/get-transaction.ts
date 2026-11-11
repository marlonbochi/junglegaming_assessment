import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { ApplicationError } from '../errors';
import type { TxRepositories, UnitOfWork } from '../ports/unit-of-work';

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  observedBalance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export class GetTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  byId(id: string): Promise<TransactionView> {
    return this.find((r) => r.transactions.findById(id), id);
  }

  byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.find((r) => r.transactions.findByExternalId(providerId, externalTransactionId), `${providerId}/${externalTransactionId}`);
  }

  private async find(load: (r: TxRepositories) => Promise<WagerTransaction | undefined>, ref: string): Promise<TransactionView> {
    const t = await this.uow.run(load);
    if (!t) throw new ApplicationError('NOT_FOUND', `Transaction ${ref} not found`);
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      money: t.money.toJSON(),
      status: t.status,
      failureCode: t.failureCode,
      referenceExternalTransactionId: t.referenceExternalTransactionId,
      referenceTransactionId: t.referenceTransactionId,
      observedBalance: t.observedBalance?.toJSON(),
      createdAt: t.createdAt.toISOString(),
      processedAt: t.processedAt?.toISOString(),
    };
  }
}
