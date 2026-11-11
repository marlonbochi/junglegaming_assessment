import type { MoneyProps } from '../../domain/money/money';
import { ApplicationError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ApplicationError('INVALID_CURSOR');
  }
  const v = typeof parsed === 'object' && parsed !== null ? (parsed as { v?: unknown }).v : undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApplicationError('INVALID_CURSOR');
  return v;
}

/** Spec §6.6: ascending by wallet_version; the cursor is the last version returned, so appends never shift pages. */
export class ListLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, cursor?: string, limit: number = DEFAULT_LIMIT): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ApplicationError('INVALID_PAYLOAD', `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const after = cursor === undefined ? 0 : decodeLedgerCursor(cursor);

    const entries = await this.uow.run(async (r) => {
      if (!(await r.wallets.findById(walletId))) throw new ApplicationError('NOT_FOUND', `Wallet ${walletId} not found`);
      return r.ledger.listByWallet(walletId, after, limit + 1);
    });

    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        walletVersion: e.walletVersion,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: entries.length > limit && last ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }
}
