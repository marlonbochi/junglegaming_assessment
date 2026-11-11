import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientInfraError, UniqueViolationError } from '../../application/errors';
import type { Metrics } from '../../application/ports/metrics';
import type { TxRepositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { classifyPgError, uniqueConstraintName } from './pg-errors';
import { MikroOrmInboxRepository } from './repositories/inbox.repository';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/outbox.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';

export interface UnitOfWorkOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * One SQL transaction per `run`. Repositories write with immediate SQL in call order, so unique
 * violations surface at the call and deferred schema guards are checked at COMMIT.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeout: string;
  private readonly statementTimeout: string;

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    opts: UnitOfWorkOptions = {},
  ) {
    this.lockTimeout = `${opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS}ms`;
    this.statementTimeout = `${opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}ms`;
  }

  async run<T>(fn: (r: TxRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // set_config(..., true) is SET LOCAL: scoped to this transaction only.
        await em.execute(`SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`, [
          this.lockTimeout,
          this.statementTimeout,
        ]);
        return fn(repositoriesFor(em));
      });
    } catch (e) {
      throw this.translate(e);
    }
  }

  private translate(e: unknown): unknown {
    switch (classifyPgError(e)) {
      case 'lock_timeout':
        this.metrics.lockConflict();
        return new TransientInfraError('lock timeout', { cause: e });
      case 'transient':
        return new TransientInfraError(e instanceof Error ? e.message : 'transient database failure', { cause: e });
      case 'unique_violation':
        return new UniqueViolationError(uniqueConstraintName(e), e instanceof Error ? e.message : undefined);
      case 'other':
        return e;
    }
  }
}

function repositoriesFor(em: EntityManager): TxRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
