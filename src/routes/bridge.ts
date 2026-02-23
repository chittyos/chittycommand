import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { ledgerClient, financeClient, plaidClient } from '../lib/integrations';
import { recordActionSchema, exchangeTokenSchema } from '../lib/validators';

export const bridgeRoutes = new Hono<{ Bindings: Env }>();

// ── ChittyLedger Sync ────────────────────────────────────────

/** Push all unsynced documents to ChittyLedger as evidence */
bridgeRoutes.post('/ledger/sync-documents', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const sql = getDb(c.env);
  const unsynced = await sql`
    SELECT * FROM cc_documents
    WHERE processing_status = 'pending'
    AND (metadata->>'ledger_evidence_id') IS NULL
    ORDER BY created_at ASC
    LIMIT 50
  `;

  let synced = 0;
  for (const doc of unsynced) {
    const evidence = await ledger.createEvidence({
      filename: doc.filename || 'unknown',
      fileType: doc.doc_type || 'upload',
      description: `Uploaded via ChittyCommand: ${doc.filename}`,
      evidenceTier: 'BUSINESS_RECORDS',
    });

    if (evidence?.id) {
      await sql`
        UPDATE cc_documents SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_evidence_id: evidence.id })}::jsonb,
          processing_status = 'synced'
        WHERE id = ${doc.id}
      `;
      synced++;
    }
  }

  return c.json({ total: unsynced.length, synced, message: `Synced ${synced} documents to ChittyLedger` });
});

/** Push disputes to ChittyLedger as cases */
bridgeRoutes.post('/ledger/sync-disputes', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const sql = getDb(c.env);
  const unsynced = await sql`
    SELECT * FROM cc_disputes
    WHERE (metadata->>'ledger_case_id') IS NULL
    ORDER BY created_at ASC
  `;

  let synced = 0;
  for (const dispute of unsynced) {
    const caseResult = await ledger.createCase({
      caseNumber: `CC-DISPUTE-${(dispute.id as string).slice(0, 8)}`,
      title: dispute.title as string,
      caseType: 'CIVIL',
      description: dispute.description as string || undefined,
    });

    if (caseResult?.id) {
      await sql`
        UPDATE cc_disputes SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseResult.id })}::jsonb
        WHERE id = ${dispute.id}
      `;
      synced++;
    }
  }

  return c.json({ total: unsynced.length, synced, message: `Synced ${synced} disputes to ChittyLedger` });
});

/** Record an action in ChittyLedger chain of custody */
bridgeRoutes.post('/ledger/record-action', async (c) => {
  const ledger = ledgerClient(c.env);
  if (!ledger) return c.json({ error: 'ChittyLedger not configured' }, 503);

  const parsed = recordActionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);

  const body = parsed.data;
  const result = await ledger.addCustodyEntry({
    evidenceId: body.evidence_id,
    action: body.action,
    performedBy: 'chittycommand',
    location: 'ChittyCommand Dashboard',
    notes: body.notes,
  });

  return c.json({ recorded: !!result });
});

// ── ChittyFinance Sync ───────────────────────────────────────

/** Pull accounts from ChittyFinance into cc_accounts */
bridgeRoutes.post('/finance/sync-accounts', async (c) => {
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
bridgeRoutes.post('/finance/sync-transactions', async (c) => {
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

// ── Plaid ────────────────────────────────────────────────────

/** Create a Plaid Link token for the frontend */
bridgeRoutes.post('/plaid/link-token', async (c) => {
  const plaid = plaidClient(c.env);
  if (!plaid) return c.json({ error: 'Plaid not configured' }, 503);

  const userId = (c as any).get('userId') || 'anonymous';
  const result = await plaid.createLinkToken(userId);
  if (!result) return c.json({ error: 'Failed to create link token' }, 502);

  return c.json(result);
});

/** Exchange public token from Plaid Link and store the linked item */
bridgeRoutes.post('/plaid/exchange-token', async (c) => {
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
bridgeRoutes.post('/plaid/sync-transactions', async (c) => {
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
bridgeRoutes.post('/plaid/sync-balances', async (c) => {
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

// ── Cross-Service Status ─────────────────────────────────────

/** Health check all connected services */
bridgeRoutes.get('/status', async (c) => {
  const services = [
    { name: 'chittyauth', url: c.env.CHITTYAUTH_URL },
    { name: 'chittyledger', url: c.env.CHITTYLEDGER_URL },
    { name: 'chittyfinance', url: c.env.CHITTYFINANCE_URL },
    { name: 'chittycharge', url: c.env.CHITTYCHARGE_URL },
    { name: 'chittyconnect', url: c.env.CHITTYCONNECT_URL },
    { name: 'plaid', url: c.env.PLAID_CLIENT_ID ? `https://${c.env.PLAID_ENV || 'sandbox'}.plaid.com` : undefined },
  ];

  const results = await Promise.all(
    services.map(async (svc) => {
      if (!svc.url) return { name: svc.name, status: 'not_configured' };
      try {
        const res = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { name: svc.name, status: res.ok ? 'ok' : 'error', code: res.status, ...data };
      } catch (err) {
        return { name: svc.name, status: 'unreachable', error: String(err) };
      }
    })
  );

  const healthy = results.filter((r) => r.status === 'ok').length;
  return c.json({ services: results, healthy, total: services.length });
});
