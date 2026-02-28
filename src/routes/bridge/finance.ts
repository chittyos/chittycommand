import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { financeClient } from '../../lib/integrations';

export const financeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── ChittyFinance Sync ───────────────────────────────────────

/** Pull accounts from ChittyFinance into cc_accounts */
financeRoutes.post('/sync-accounts', async (c) => {
  const finance = financeClient(c.env);
  if (!finance) return c.json({ error: 'ChittyFinance not configured' }, 503);

  const accounts = await finance.getAccounts();
  if (!accounts) return c.json({ error: 'Failed to fetch accounts from ChittyFinance' }, 502);

  const sql = getDb(c.env);
  let created = 0;
  let updated = 0;

  for (const acct of accounts) {
    const [existing] = await sql`
      SELECT id FROM cc_accounts WHERE source_id = ${acct.id} AND source = 'chittyfinance'
    `;

    if (existing) {
      await sql`
        UPDATE cc_accounts SET
          current_balance = ${acct.balance},
          last_synced_at = NOW(),
          updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      updated++;
    } else {
      const typeMap: Record<string, string> = {
        checking: 'checking', savings: 'savings', credit: 'credit_card',
      };
      await sql`
        INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, last_synced_at)
        VALUES ('chittyfinance', ${acct.id}, ${acct.name}, ${typeMap[acct.type] || acct.type}, ${acct.institution}, ${acct.balance}, NOW())
      `;
      created++;
    }
  }

  return c.json({ fetched: accounts.length, created, updated });
});

/** Pull transactions from ChittyFinance into cc_transactions */
financeRoutes.post('/sync-transactions', async (c) => {
  const finance = financeClient(c.env);
  if (!finance) return c.json({ error: 'ChittyFinance not configured' }, 503);

  const sql = getDb(c.env);

  // Get all accounts sourced from chittyfinance
  const accounts = await sql`
    SELECT id, source_id FROM cc_accounts WHERE source = 'chittyfinance'
  `;

  let totalImported = 0;

  for (const acct of accounts) {
    // Get last synced transaction date
    const [latest] = await sql`
      SELECT MAX(tx_date) as last_date FROM cc_transactions WHERE account_id = ${acct.id}
    `;
    const since = latest?.last_date || '2024-01-01';

    const txns = await finance.getTransactions(acct.source_id as string, since as string);
    if (!txns) continue;

    for (const tx of txns) {
      // Dedup by source_id
      const [exists] = await sql`
        SELECT id FROM cc_transactions WHERE source_id = ${tx.id} AND source = 'chittyfinance'
      `;
      if (exists) continue;

      await sql`
        INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, category, counterparty, tx_date)
        VALUES (${acct.id}, 'chittyfinance', ${tx.id}, ${Math.abs(tx.amount)}, ${tx.direction}, ${tx.description}, ${tx.category || null}, ${tx.counterparty || null}, ${tx.date})
      `;
      totalImported++;
    }
  }

  return c.json({ accounts_checked: accounts.length, transactions_imported: totalImported });
});
