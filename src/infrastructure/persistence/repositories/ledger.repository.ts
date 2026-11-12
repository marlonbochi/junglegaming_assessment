import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/ports/ledger.repository';
import { Money } from '../../../domain/money/money';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { ledgerEntryToDomain, ledgerEntryToRecord } from '../mappers/ledger-entry.mapper';
import { LedgerEntrySchema } from '../schemas/ledger-entry.schema';
import { FRESH } from './read-options';

interface TotalsRow {
  credits: string;
  debits: string;
  count: number;
  last_balance_after: string | null;
}

/** Sums can outgrow numeric(20,2), so they are parsed into minor units instead of through `Money.from`. */
function sumToMoney(sum: string, currency: string): Money {
  return Money.fromMinorUnits(BigInt(sum.replace('.', '')), currency);
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(e: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(e));
  }

  async listByWallet(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      { walletId, walletVersion: { $gt: afterVersion } },
      { ...FRESH, orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  async totals(
    walletId: string,
    currency: string,
  ): Promise<{ credits: Money; debits: Money; count: number; lastBalanceAfter?: Money }> {
    // round(x, 2) keeps two decimals even for an empty sum, so the text is always "<digits>.<2 digits>".
    const [row] = await this.em.execute<TotalsRow[]>(
      `SELECT round(coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0), 2)::text AS credits,
              round(coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0), 2)::text AS debits,
              count(*)::int AS count,
              (SELECT balance_after::text FROM wallet_ledger_entries
                WHERE wallet_id = ? AND currency = ? ORDER BY wallet_version DESC LIMIT 1) AS last_balance_after
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND currency = ?`,
      [walletId, currency, walletId, currency],
    );
    if (!row) throw new Error('Ledger totals query returned no row');
    return {
      credits: sumToMoney(row.credits, currency),
      debits: sumToMoney(row.debits, currency),
      count: row.count,
      lastBalanceAfter:
        row.last_balance_after === null ? undefined : Money.from({ amount: row.last_balance_after, currency }),
    };
  }
}
