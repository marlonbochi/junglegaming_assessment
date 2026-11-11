import type { MoneyProps } from '../../domain/money/money';
import { ApplicationError } from '../errors';
import type { AppLogger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Spec §6.6: compares the stored balance with Σcredits − Σdebits in one snapshot. Reports, never repairs. */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const { stored, calculated, count } = await this.uow.run(
      async (r) => {
        const wallet = await r.wallets.findById(walletId);
        if (!wallet) throw new ApplicationError('NOT_FOUND', `Wallet ${walletId} not found`);
        const totals = await r.ledger.totals(walletId, wallet.currency);
        return { stored: wallet.balance, calculated: totals.credits.subtract(totals.debits), count: totals.count };
      },
      { isolation: 'repeatable read' },
    );

    const consistent = stored.equals(calculated);
    if (!consistent) {
      // Constitution #29: no amounts in logs; they travel in the response only.
      this.logger.error({ walletId, checkedEntries: count, consistent: false }, 'wallet reconciliation mismatch');
      this.metrics.reconciliationMismatch();
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent,
      checkedEntries: count,
    };
  }
}
