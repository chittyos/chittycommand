import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient, booksClient, assetsClient, scrapeClient } from '../lib/integrations';
import { recordActionSchema, exchangeTokenSchema, recordBookTransactionSchema, submitEvidenceSchema, courtDocketScrapeSchema } from '../lib/validators';

export const bridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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

  const userId = c.get('userId') || 'anonymous';
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

// ── Mercury ─────────────────────────────────────────────────

interface MercuryOrg {
  slug: string;
  opRef: string;
}

/** Refresh Mercury tokens from ChittyConnect/1Password into KV */
bridgeRoutes.post('/mercury/refresh-tokens', async (c) => {
  const connect = connectClient(c.env);
  const orgsJson = await c.env.COMMAND_KV.get('mercury:orgs');
  if (!orgsJson) return c.json({ error: 'No mercury:orgs configured in KV' }, 404);

  const orgs: MercuryOrg[] = JSON.parse(orgsJson);
  let refreshed = 0;
  let failed = 0;

  for (const org of orgs) {
    try {
      let token: string | null = null;
      if (connect) {
        const res = await fetch(`${c.env.CHITTYCONNECT_URL}/api/credentials/${encodeURIComponent(org.opRef)}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { value: string };
          token = data.value;
        }
      }
      if (token) {
        await c.env.COMMAND_KV.put(`mercury:token:${org.slug}`, token);
        refreshed++;
      } else {
        const cached = await c.env.COMMAND_KV.get(`mercury:token:${org.slug}`);
        if (cached) {
          console.log(`[mercury] Using cached token for ${org.slug}`);
        } else {
          failed++;
          console.error(`[mercury] No token available for ${org.slug}`);
        }
      }
    } catch (err) {
      failed++;
      console.error(`[mercury] Token refresh failed for ${org.slug}:`, err);
    }
  }

  return c.json({ orgs: orgs.length, refreshed, failed });
});

/** Sync accounts from all Mercury orgs */
bridgeRoutes.post('/mercury/sync-accounts', async (c) => {
  const orgsJson = await c.env.COMMAND_KV.get('mercury:orgs');
  if (!orgsJson) return c.json({ error: 'No mercury:orgs configured in KV' }, 404);

  const orgs: MercuryOrg[] = JSON.parse(orgsJson);
  const sql = getDb(c.env);
  let totalCreated = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  for (const org of orgs) {
    const token = await c.env.COMMAND_KV.get(`mercury:token:${org.slug}`);
    if (!token) {
      errors.push(`${org.slug}: no token`);
      continue;
    }

    const mercury = mercuryClient(token);
    const result = await mercury.getAccounts();
    if (!result?.accounts) {
      errors.push(`${org.slug}: API call failed`);
      continue;
    }

    for (const acct of result.accounts) {
      if (acct.status !== 'active') continue;

      const [existing] = await sql`
        SELECT id FROM cc_accounts WHERE source_id = ${acct.id} AND source = 'mercury'
      `;

      const typeMap: Record<string, string> = { mercury: 'checking', savings: 'savings' };
      const accountType = typeMap[acct.kind] || 'checking';

      if (existing) {
        await sql`
          UPDATE cc_accounts SET
            current_balance = ${acct.currentBalance},
            last_synced_at = NOW(),
            updated_at = NOW()
          WHERE id = ${existing.id}
        `;
        totalUpdated++;
      } else {
        await sql`
          INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, last_synced_at, metadata)
          VALUES ('mercury', ${acct.id}, ${acct.name}, ${accountType}, ${'Mercury'}, ${acct.currentBalance}, NOW(),
                  ${JSON.stringify({ mercury_org: org.slug, mercury_kind: acct.kind, mercury_status: acct.status })}::jsonb)
        `;
        totalCreated++;
      }
    }
  }

  return c.json({ orgs: orgs.length, created: totalCreated, updated: totalUpdated, errors });
});

/** Sync transactions from all Mercury accounts */
bridgeRoutes.post('/mercury/sync-transactions', async (c) => {
  const sql = getDb(c.env);

  const accounts = await sql`
    SELECT id, source_id, metadata FROM cc_accounts WHERE source = 'mercury'
  `;

  const orgAccounts = new Map<string, { dbId: string; sourceId: string }[]>();
  for (const acct of accounts) {
    const meta = (acct.metadata || {}) as Record<string, string>;
    const org = meta.mercury_org;
    if (!org) continue;
    if (!orgAccounts.has(org)) orgAccounts.set(org, []);
    orgAccounts.get(org)!.push({ dbId: acct.id as string, sourceId: acct.source_id as string });
  }

  let totalAdded = 0;
  const errors: string[] = [];

  for (const [orgSlug, accts] of orgAccounts) {
    const token = await c.env.COMMAND_KV.get(`mercury:token:${orgSlug}`);
    if (!token) {
      errors.push(`${orgSlug}: no token`);
      continue;
    }

    const mercury = mercuryClient(token);

    for (const acct of accts) {
      const cursor = await c.env.COMMAND_KV.get(`mercury:cursor:${acct.sourceId}`);
      const start = cursor || '2024-01-01';

      const result = await mercury.getTransactions(acct.sourceId, { start, limit: 500 });
      if (!result?.transactions) continue;

      const txIds = result.transactions.map((tx) => tx.id);
      const existingRows = txIds.length > 0
        ? await sql`SELECT source_id FROM cc_transactions WHERE source = 'mercury' AND source_id = ANY(${txIds})`
        : [];
      const existingIds = new Set(existingRows.map((r: any) => r.source_id));

      for (const tx of result.transactions) {
        if (existingIds.has(tx.id)) continue;
        if (tx.status === 'cancelled') continue;

        const direction = tx.amount >= 0 ? 'inflow' : 'outflow';
        const counterparty = tx.counterpartyNickname || tx.counterpartyName || null;
        const description = tx.externalMemo || tx.bankDescription || tx.counterpartyName;
        const txDate = tx.postedAt ? tx.postedAt.split('T')[0] : tx.createdAt.split('T')[0];

        await sql`
          INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, counterparty, tx_date, posted_at, metadata)
          VALUES (${acct.dbId}, 'mercury', ${tx.id}, ${Math.abs(tx.amount)}, ${direction}, ${description}, ${counterparty}, ${txDate},
                  ${tx.postedAt || null}, ${JSON.stringify({ mercury_kind: tx.kind, mercury_status: tx.status })}::jsonb)
          ON CONFLICT DO NOTHING
        `;
        totalAdded++;
      }

      if (result.transactions.length > 0) {
        const latestDate = result.transactions
          .map((tx) => tx.postedAt || tx.createdAt)
          .sort()
          .pop();
        if (latestDate) {
          await c.env.COMMAND_KV.put(`mercury:cursor:${acct.sourceId}`, latestDate.split('T')[0]);
        }
      }
    }
  }

  return c.json({ accounts: accounts.length, transactions_added: totalAdded, errors });
});

// ── ChittyBooks ─────────────────────────────────────────────

/** Record a transaction in ChittyBooks for bookkeeping */
bridgeRoutes.post('/books/record-transaction', async (c) => {
  const books = booksClient(c.env);
  if (!books) return c.json({ error: 'ChittyBooks not configured' }, 503);

  const parsed = recordBookTransactionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  const result = await books.recordTransaction(body);
  if (!result) return c.json({ error: 'Failed to record transaction in ChittyBooks' }, 502);

  const sql = getDb(c.env);
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
    VALUES ('books_record', 'transaction', ${body.description}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb, 'completed')
  `;

  return c.json({ recorded: true, books_result: result });
});

/** Get ChittyBooks financial summary */
bridgeRoutes.get('/books/summary', async (c) => {
  const books = booksClient(c.env);
  if (!books) return c.json({ error: 'ChittyBooks not configured' }, 503);

  const summary = await books.getSummary();
  if (!summary) return c.json({ error: 'Failed to fetch summary from ChittyBooks' }, 502);

  return c.json(summary);
});


// ── ChittyAssets ────────────────────────────────────────────

/** Sync property/asset data from ChittyAssets into cc_properties */
bridgeRoutes.post('/assets/sync-properties', async (c) => {
  const assets = assetsClient(c.env);
  if (!assets) return c.json({ error: 'ChittyAssets not configured' }, 503);

  const assetList = await assets.getAssets();
  if (!assetList) return c.json({ error: 'Failed to fetch assets from ChittyAssets' }, 502);

  const sql = getDb(c.env);
  let created = 0;
  let updated = 0;

  for (const asset of assetList) {
    if (!asset.address) continue;

    const [existing] = await sql`
      SELECT id FROM cc_properties WHERE address = ${asset.address as string} AND unit = ${(asset.unit as string) || null}
    `;

    if (existing) {
      await sql`
        UPDATE cc_properties SET
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ chittyassets_id: asset.id, last_synced: new Date().toISOString() })}::jsonb,
          updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      updated++;
    } else {
      await sql`
        INSERT INTO cc_properties (address, unit, property_type, metadata)
        VALUES (${asset.address as string}, ${(asset.unit as string) || null}, ${(asset.propertyType as string) || null},
                ${JSON.stringify({ chittyassets_id: asset.id, source: 'chittyassets' })}::jsonb)
      `;
      created++;
    }
  }

  return c.json({ fetched: assetList.length, created, updated });
});

/** Push an action result to ChittyAssets evidence ledger */
bridgeRoutes.post('/assets/submit-evidence', async (c) => {
  const assets = assetsClient(c.env);
  if (!assets) return c.json({ error: 'ChittyAssets not configured' }, 503);

  const parsed = submitEvidenceSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  const result = await assets.submitEvidence({
    evidenceType: body.evidenceType,
    data: body.data,
    metadata: { ...body.metadata, submissionSource: 'ChittyCommand' },
  });

  if (!result) return c.json({ error: 'Failed to submit evidence to ChittyAssets' }, 502);

  const sql = getDb(c.env);
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
    VALUES ('assets_evidence', 'evidence', ${body.evidenceType}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb, 'completed')
  `;

  return c.json({ submitted: true, chittyId: result.chittyId, trustScore: result.trustScore });
});

// ── ChittyScrape ─────────────────────────────────────────────

/** Trigger court docket scrape */
bridgeRoutes.post('/scrape/court-docket', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const parsed = courtDocketScrapeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const targetCase = parsed.data.caseNumber || '2024D007847';

  const result = await scrape.scrapeCourtDocket(targetCase, token);

  const sql = getDb(c.env);
  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('court_docket', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.data?.entries?.length || 0}, ${result?.error || null})`;

  if (result?.success && result.data) {
    for (const entry of result.data.entries) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata)
        VALUES (${targetCase}, 'cook_county_circuit', 'docket_entry', ${entry.description?.slice(0, 500) || 'Docket entry'}, ${entry.description || null}, ${entry.date || new Date().toISOString()}, ${{ filedBy: entry.filedBy, scraped: true }}::jsonb)
        ON CONFLICT DO NOTHING
      `;
    }

    if (result.data.nextHearing) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, deadline_date, urgency_score, metadata)
        VALUES (${targetCase}, 'cook_county_circuit', 'hearing', ${'Next Hearing: ' + targetCase}, ${result.data.nextHearing}, 90, ${{ scraped: true }}::jsonb)
        ON CONFLICT DO NOTHING
      `;
    }
  }

  return c.json({ source: 'court_docket', result });
});

/** Trigger Cook County tax scrape for all properties */
bridgeRoutes.post('/scrape/cook-county-tax', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const sql = getDb(c.env);
  const properties = await sql`SELECT id, address, unit, tax_pin, metadata FROM cc_properties WHERE tax_pin IS NOT NULL`;

  const results = [];
  for (const prop of properties) {
    const result = await scrape.scrapeCookCountyTax(prop.tax_pin as string, token);
    results.push({ pin: prop.tax_pin, result });

    if (result?.success && result.data) {
      await sql`
        UPDATE cc_properties SET
          annual_tax = ${result.data.totalTax},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ tax_year: result.data.taxYear, tax_installments: result.data.installments, last_tax_scrape: new Date().toISOString() })}::jsonb,
          updated_at = NOW()
        WHERE id = ${prop.id}
      `;
    }

    await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
      VALUES ('cook_county_tax', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;
  }

  return c.json({ properties_scraped: properties.length, results });
});

/** Trigger Mr. Cooper scrape */
bridgeRoutes.post('/scrape/mr-cooper', async (c) => {
  const scrape = scrapeClient(c.env);
  if (!scrape) return c.json({ error: 'ChittyScrape not configured' }, 503);

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  if (!token) return c.json({ error: 'Scrape service token not configured' }, 503);

  const result = await scrape.scrapeMrCooper('addison', token);

  const sql = getDb(c.env);
  await sql`INSERT INTO cc_sync_log (source, sync_type, status, records_synced, error_message)
    VALUES ('mr_cooper', 'scrape', ${result?.success ? 'success' : 'error'}, ${result?.success ? 1 : 0}, ${result?.error || null})`;

  if (result?.success && result.data) {
    await sql`
      UPDATE cc_obligations SET
        amount_due = ${result.data.monthlyPayment},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          mortgage_balance: result.data.currentBalance,
          escrow_balance: result.data.escrowBalance,
          interest_rate: result.data.interestRate,
          payoff_amount: result.data.payoffAmount,
          last_scrape: new Date().toISOString(),
        })}::jsonb,
        updated_at = NOW()
      WHERE payee ILIKE '%Mr. Cooper%' AND payee ILIKE '%Addison%'
    `;
  }

  return c.json({ source: 'mr_cooper', result });
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
    { name: 'chittybooks', url: c.env.CHITTYBOOKS_URL },
    { name: 'chittyassets', url: c.env.CHITTYASSETS_URL },
    { name: 'mercury', url: 'https://api.mercury.com' },
    { name: 'chittyscrape', url: c.env.CHITTYSCRAPE_URL },
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
