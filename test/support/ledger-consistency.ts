import type { SQL } from 'bun';

interface WalletLedgerRow {
  id: string;
  balance: string;
  version: number;
  ledger_balance: string;
  entries: number;
  first_version: number | null;
  last_version: number | null;
  last_balance_after: string | null;
}

/**
 * Constitution #6/#26: every wallet (or only `walletIds`) must match the ledger rebuilt from its entries.
 * - balance == Σcredit − Σdebit
 * - balance == balance_after of the highest wallet_version (0.00 without entries)
 * - wallet_version chain is continuous, starts at 1 (opening > 0) or 2 (opening 0) and ends at the wallet version
 * - count(entries) == version (opening > 0) or version − 1 (opening 0)
 */
export async function assertLedgerConsistency(sql: SQL, walletIds?: string[]): Promise<void> {
  if (walletIds?.length === 0) return;
  const filter = walletIds ? sql`WHERE w.id IN ${sql(walletIds)}` : sql``;
  const rows: WalletLedgerRow[] = await sql`
    SELECT w.id,
           w.balance::text AS balance,
           w.version,
           round(coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0), 2)::text
             AS ledger_balance,
           count(e.id)::int AS entries,
           min(e.wallet_version) AS first_version,
           max(e.wallet_version) AS last_version,
           (SELECT l.balance_after::text FROM wallet_ledger_entries l
             WHERE l.wallet_id = w.id ORDER BY l.wallet_version DESC LIMIT 1) AS last_balance_after
      FROM wallets w
      LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      ${filter}
     GROUP BY w.id`;

  const violations = rows.flatMap(walletViolations);
  const found = new Set(rows.map((r) => r.id));
  for (const id of walletIds ?? []) if (!found.has(id)) violations.push(`wallet ${id}: not found`);
  if (violations.length > 0) throw new Error(`Ledger inconsistency:\n${violations.join('\n')}`);
}

function walletViolations(r: WalletLedgerRow): string[] {
  const out: string[] = [];
  const fail = (msg: string) => out.push(`wallet ${r.id}: ${msg}`);

  if (r.balance !== r.ledger_balance) fail(`balance ${r.balance} != ledger sum ${r.ledger_balance}`);
  const lastAfter = r.last_balance_after ?? '0.00';
  if (r.balance !== lastAfter) fail(`balance ${r.balance} != last balance_after ${lastAfter}`);

  if (r.entries === 0) {
    if (r.version !== 1) fail(`version ${r.version} without ledger entries`);
    return out;
  }
  const first = r.first_version ?? 0;
  const last = r.last_version ?? 0;
  if (first !== 1 && first !== 2) fail(`chain starts at wallet_version ${first}, expected 1 or 2`);
  if (last - first + 1 !== r.entries) fail(`chain ${first}..${last} has gaps (${r.entries} entries)`);
  if (last !== r.version) fail(`last wallet_version ${last} != wallet version ${r.version}`);
  const expectedEntries = first === 1 ? r.version : r.version - 1;
  if (r.entries !== expectedEntries) fail(`${r.entries} entries, expected ${expectedEntries} for version ${r.version}`);
  return out;
}
