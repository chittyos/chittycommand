import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { plaidClient } from '../../lib/integrations';
import { exchangeTokenSchema } from '../../lib/validators';

export const plaidRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Plaid ────────────────────────────────────────────────────

/** Create a Plaid Link token for the frontend */
plaidRoutes.post('/link-token', async (c) => {
  const plaid = plaidClient(c.env);
  if (!plaid) return c.json({ error: 'Plaid not configured' }, 503);

  const userId = c.get('userId') || 'anonymous';
  const result = await plaid.createLinkToken(userId);
  if (!result) return c.json({ error: 'Failed to create link token' }, 502);

  return c.json(result);
});

/** Exchange public token from Plaid Link and store the linked item */
plaidRoutes.post('/exchange-token', async (c) => {
  const plaid = plaidClient(c.env);
  if (!plaid) return c.json({ error: 'Plaid not configured' }, 503);

  const parsed = exchangeTokenSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'public_token required' }, 400);
  const { public_token } = parsed.data;

  const result = await plaid.exchangePublicToken(public_token);
  if (!result) return c.json({ error: 'Token exchange failed' }, 502);

  const sql = getDb(c.env);

  // Store the access token securely in KV (not in the DB)
  await c.env.COMMAND_KV.put(`plaid:access_token:${result.item_id}`, result.access_token);

  // Fetch accounts for this item and upsert into cc_accounts
  const acctResult = await plaid.getAccounts(result.access_token);
  let created = 0;

  if (acctResult?.accounts) {
    for (const acct of acctResult.accounts) {
      const [existing] = await sql`
        SELECT id FROM cc_accounts WHERE source_id = ${acct.account_id} AND source = 'plaid'
      `;
      if (existing) continue;

      const typeMap: Record<string, string> = {
        depository: 'checking', credit: 'credit_card', loan: 'loan', investment: 'investment',
      };
      await sql`
        INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, last_synced_at, metadata)
        VALUES ('plaid', ${acct.account_id}, ${acct.name}, ${typeMap[acct.type] || acct.type}, ${'Plaid:' + (acct.official_name || acct.name)}, ${acct.balances.current || 0}, NOW(), ${JSON.stringify({ plaid_item_id: result.item_id, mask: acct.mask, subtype: acct.subtype })})
      `;
      created++;
    }
  }

  return c.json({ item_id: result.item_id, accounts_linked: created });
});

/** Sync transactions from all Plaid-linked accounts */
plaidRoutes.post('/sync-transactions', async (c) => {
  const plaid = plaidClient(c.env);
  if (!plaid) return c.json({ error: 'Plaid not configured' }, 503);

  const sql = getDb(c.env);

  // Get all Plaid-sourced accounts grouped by item_id
  const accounts = await sql`
    SELECT id, source_id, metadata FROM cc_accounts WHERE source = 'plaid'
  `;

  // Group by plaid_item_id to avoid redundant API calls
  const itemIds = new Set<string>();
  const accountMap = new Map<string, { dbId: string; sourceId: string }[]>();
  for (const acct of accounts) {
    const meta = (acct.metadata || {}) as Record<string, string>;
    const itemId = meta.plaid_item_id;
    if (!itemId) continue;
    itemIds.add(itemId);
    if (!accountMap.has(itemId)) accountMap.set(itemId, []);
    accountMap.get(itemId)!.push({ dbId: acct.id as string, sourceId: acct.source_id as string });
  }

  let totalAdded = 0;

  for (const itemId of itemIds) {
    const accessToken = await c.env.COMMAND_KV.get(`plaid:access_token:${itemId}`);
    if (!accessToken) continue;

    // Get cursor from KV for incremental sync
    const cursor = await c.env.COMMAND_KV.get(`plaid:cursor:${itemId}`) || undefined;
    let hasMore = true;
    let currentCursor = cursor;

    while (hasMore) {
      const result = await plaid.syncTransactions(accessToken, currentCursor);
      if (!result) break;

      const itemAccounts = accountMap.get(itemId) || [];

      for (const tx of result.added) {
        // Find the matching cc_account
        const match = itemAccounts.find((a) => a.sourceId === tx.account_id);
        if (!match) continue;

        // Dedup by source_id
        const [exists] = await sql`
          SELECT id FROM cc_transactions WHERE source_id = ${tx.transaction_id} AND source = 'plaid'
        `;
        if (exists) continue;

        // Plaid: positive amount = money leaving account (outflow), negative = inflow
        const direction = tx.amount > 0 ? 'outflow' : 'inflow';
        await sql`
          INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, category, counterparty, tx_date)
          VALUES (${match.dbId}, 'plaid', ${tx.transaction_id}, ${Math.abs(tx.amount)}, ${direction}, ${tx.name}, ${tx.category?.[0] || null}, ${tx.merchant_name || null}, ${tx.date})
        `;
        totalAdded++;
      }

      currentCursor = result.next_cursor;
      hasMore = result.has_more;
    }

    // Persist cursor for next incremental sync
    if (currentCursor) {
      await c.env.COMMAND_KV.put(`plaid:cursor:${itemId}`, currentCursor);
    }
  }

  return c.json({ items_checked: itemIds.size, accounts: accounts.length, transactions_added: totalAdded });
});

/** Refresh balances from Plaid */
plaidRoutes.post('/sync-balances', async (c) => {
  const plaid = plaidClient(c.env);
  if (!plaid) return c.json({ error: 'Plaid not configured' }, 503);

  const sql = getDb(c.env);
  const accounts = await sql`
    SELECT id, source_id, metadata FROM cc_accounts WHERE source = 'plaid'
  `;

  const itemIds = new Set<string>();
  for (const acct of accounts) {
    const meta = (acct.metadata || {}) as Record<string, string>;
    if (meta.plaid_item_id) itemIds.add(meta.plaid_item_id);
  }

  let updated = 0;
  for (const itemId of itemIds) {
    const accessToken = await c.env.COMMAND_KV.get(`plaid:access_token:${itemId}`);
    if (!accessToken) continue;

    const result = await plaid.getBalances(accessToken);
    if (!result?.accounts) continue;

    for (const acct of result.accounts) {
      await sql`
        UPDATE cc_accounts SET
          current_balance = ${acct.balances.current || 0},
          last_synced_at = NOW(),
          updated_at = NOW()
        WHERE source_id = ${acct.account_id} AND source = 'plaid'
      `;
      updated++;
    }
  }

  return c.json({ items_checked: itemIds.size, accounts_updated: updated });
});
