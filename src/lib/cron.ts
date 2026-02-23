import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { plaidClient, financeClient, mercuryClient } from './integrations';
import { runTriage } from './triage';
import { matchTransactions } from './matcher';
import { generateProjections } from './projections';

/**
 * Cron sync orchestrator.
 *
 * Each sync phase is wrapped in its own try/catch so failures in one
 * phase don't prevent subsequent phases from running.
 */
export async function runCronSync(
  event: ScheduledEvent,
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<void> {
  const cronSources: Record<string, string> = {
    '0 12 * * *': 'daily_api',
    '0 13 * * *': 'court_docket',
    '0 14 * * 1': 'utility_scrape',
    '0 15 1 * *': 'monthly_check',
  };

  const source = cronSources[event.cron];
  if (!source) return;

  let logId: string | undefined;

  try {
    const [log] = await sql`
      INSERT INTO cc_sync_log (source, sync_type, status)
      VALUES (${source}, 'scheduled', 'started')
      RETURNING id
    `;
    logId = log.id;

    let recordsSynced = 0;

    if (source === 'daily_api') {
      // Phase 0: Mercury sync (multi-org)
      try {
        recordsSynced += await syncMercury(env, sql);
      } catch (err) {
        console.error('[cron:mercury] failed:', err);
      }

      // Phase 1: Plaid sync
      try {
        recordsSynced += await syncPlaid(env, sql);
      } catch (err) {
        console.error('[cron:plaid] failed:', err);
      }

      // Phase 2: ChittyFinance sync
      try {
        recordsSynced += await syncFinance(env, sql);
      } catch (err) {
        console.error('[cron:finance] failed:', err);
      }

      // Phase 3: Transaction matching
      try {
        const matchResult = await matchTransactions(sql);
        console.log(`[matcher] scanned=${matchResult.transactions_scanned} matched=${matchResult.matches_found} paid=${matchResult.obligations_marked_paid}`);
        recordsSynced += matchResult.matches_found;
      } catch (err) {
        console.error('[matcher] failed:', err);
      }

      // Phase 4: AI triage
      try {
        const triageResult = await runTriage(sql);
        console.log(`[triage] scored=${triageResult.obligations_scored} recs=${triageResult.recommendations_created} overdue=${triageResult.overdue_flipped}`);
      } catch (err) {
        console.error('[triage] failed:', err);
      }

      // Phase 5: Cash flow projections
      try {
        const projResult = await generateProjections(sql);
        console.log(`[projections] ${projResult.days_projected}d: low=$${projResult.lowest_balance} on ${projResult.lowest_balance_date}`);
      } catch (err) {
        console.error('[projections] failed:', err);
      }
    }

    await sql`
      UPDATE cc_sync_log SET status = 'completed', records_synced = ${recordsSynced}, completed_at = NOW()
      WHERE id = ${logId}
    `;
  } catch (err) {
    console.error(`Scheduled sync failed [${source}]:`, err);
    if (logId) {
      await sql`
        UPDATE cc_sync_log SET status = 'error', error_message = ${String(err)}, completed_at = NOW()
        WHERE id = ${logId}
      `.catch(() => {});
    }
  }
}

/**
 * Sync Plaid balances and transactions.
 * Uses batch lookups to avoid N+1 query patterns.
 */
export async function syncPlaid(env: Env, sql: NeonQueryFunction<false, false>): Promise<number> {
  const plaid = plaidClient(env);
  if (!plaid) return 0;

  let recordsSynced = 0;

  // Get all Plaid items
  const accounts = await sql`
    SELECT DISTINCT metadata->>'plaid_item_id' AS item_id
    FROM cc_accounts WHERE source = 'plaid' AND metadata->>'plaid_item_id' IS NOT NULL
  `;

  for (const row of accounts) {
    const itemId = row.item_id as string;
    const accessToken = await env.COMMAND_KV.get(`plaid:access_token:${itemId}`);
    if (!accessToken) continue;

    // Sync balances
    const balances = await plaid.getBalances(accessToken);
    if (balances?.accounts) {
      for (const acct of balances.accounts) {
        await sql`
          UPDATE cc_accounts SET current_balance = ${acct.balances.current || 0}, last_synced_at = NOW()
          WHERE source_id = ${acct.account_id} AND source = 'plaid'
        `;
      }
    }

    // Sync transactions incrementally
    const cursor = await env.COMMAND_KV.get(`plaid:cursor:${itemId}`) || undefined;
    let hasMore = true;
    let currentCursor = cursor;

    // Pre-fetch account ID mapping for this item to avoid N+1
    const itemAccounts = await sql`
      SELECT id, source_id FROM cc_accounts WHERE source = 'plaid' AND metadata->>'plaid_item_id' = ${itemId}
    `;
    const accountIdMap = new Map<string, string>();
    for (const a of itemAccounts) {
      accountIdMap.set(a.source_id as string, a.id as string);
    }

    while (hasMore) {
      const txResult = await plaid.syncTransactions(accessToken, currentCursor);
      if (!txResult) break;

      // Pre-fetch existing transaction IDs to avoid per-tx SELECT
      const txIds = txResult.added.map((tx: any) => tx.transaction_id);
      const existingRows = txIds.length > 0
        ? await sql`SELECT source_id FROM cc_transactions WHERE source = 'plaid' AND source_id = ANY(${txIds})`
        : [];
      const existingIds = new Set(existingRows.map((r: any) => r.source_id));

      for (const tx of txResult.added) {
        if (existingIds.has(tx.transaction_id)) continue;
        const dbAccountId = accountIdMap.get(tx.account_id);
        if (!dbAccountId) continue;

        const direction = tx.amount > 0 ? 'outflow' : 'inflow';
        await sql`
          INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, category, counterparty, tx_date)
          VALUES (${dbAccountId}, 'plaid', ${tx.transaction_id}, ${Math.abs(tx.amount)}, ${direction}, ${tx.name}, ${tx.category?.[0] || null}, ${tx.merchant_name || null}, ${tx.date})
          ON CONFLICT DO NOTHING
        `;
        recordsSynced++;
      }

      currentCursor = txResult.next_cursor;
      hasMore = txResult.has_more;
    }

    if (currentCursor) {
      await env.COMMAND_KV.put(`plaid:cursor:${itemId}`, currentCursor);
    }
  }

  return recordsSynced;
}

/**
 * Sync ChittyFinance accounts and transactions.
 * Uses batch lookups to avoid N+1 query patterns.
 */
export async function syncFinance(env: Env, sql: NeonQueryFunction<false, false>): Promise<number> {
  const finance = financeClient(env);
  if (!finance) return 0;

  let recordsSynced = 0;

  // Sync accounts
  const finAccounts = await finance.getAccounts();
  if (finAccounts) {
    for (const acct of finAccounts) {
      const [existing] = await sql`SELECT id FROM cc_accounts WHERE source_id = ${acct.id} AND source = 'chittyfinance'`;
      if (existing) {
        await sql`UPDATE cc_accounts SET current_balance = ${acct.balance}, last_synced_at = NOW() WHERE id = ${existing.id}`;
      } else {
        await sql`
          INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, last_synced_at)
          VALUES ('chittyfinance', ${acct.id}, ${acct.name}, ${acct.type}, ${acct.institution}, ${acct.balance}, NOW())
        `;
      }
    }
  }

  // Sync transactions for all chittyfinance accounts
  const cfAccounts = await sql`SELECT id, source_id FROM cc_accounts WHERE source = 'chittyfinance'`;
  for (const acct of cfAccounts) {
    const [latest] = await sql`SELECT MAX(tx_date) as last_date FROM cc_transactions WHERE account_id = ${acct.id}`;
    const since = (latest?.last_date as string) || '2024-01-01';
    const txns = await finance.getTransactions(acct.source_id as string, since);
    if (!txns) continue;

    // Pre-fetch existing transaction IDs for this account
    const txIds = txns.map((tx: any) => tx.id);
    const existingRows = txIds.length > 0
      ? await sql`SELECT source_id FROM cc_transactions WHERE source = 'chittyfinance' AND source_id = ANY(${txIds})`
      : [];
    const existingIds = new Set(existingRows.map((r: any) => r.source_id));

    for (const tx of txns) {
      if (existingIds.has(tx.id)) continue;
      await sql`
        INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, category, counterparty, tx_date)
        VALUES (${acct.id}, 'chittyfinance', ${tx.id}, ${Math.abs(tx.amount)}, ${tx.direction}, ${tx.description}, ${tx.category || null}, ${tx.counterparty || null}, ${tx.date})
        ON CONFLICT DO NOTHING
      `;
      recordsSynced++;
    }
  }

  return recordsSynced;
}

/**
 * Refresh Mercury tokens from ChittyConnect, then sync accounts and transactions.
 * Each org syncs independently — a failed org doesn't block others.
 */
export async function syncMercury(env: Env, sql: NeonQueryFunction<false, false>): Promise<number> {
  const orgsJson = await env.COMMAND_KV.get('mercury:orgs');
  if (!orgsJson) return 0;

  interface MercuryOrg { slug: string; opRef: string; }
  const orgs: MercuryOrg[] = JSON.parse(orgsJson);
  let recordsSynced = 0;

  // Phase A: Refresh tokens from ChittyConnect
  if (env.CHITTYCONNECT_URL) {
    for (const org of orgs) {
      try {
        const res = await fetch(`${env.CHITTYCONNECT_URL}/api/credentials/${encodeURIComponent(org.opRef)}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { value: string };
          await env.COMMAND_KV.put(`mercury:token:${org.slug}`, data.value);
        }
      } catch (err) {
        console.error(`[cron:mercury] Token refresh failed for ${org.slug}:`, err);
      }
    }
  }

  // Phase B: Sync accounts and transactions per org
  for (const org of orgs) {
    const token = await env.COMMAND_KV.get(`mercury:token:${org.slug}`);
    if (!token) continue;

    const mercury = mercuryClient(token);

    // Sync accounts
    const acctResult = await mercury.getAccounts();
    if (acctResult?.accounts) {
      for (const acct of acctResult.accounts) {
        if (acct.status !== 'active') continue;
        const typeMap: Record<string, string> = { mercury: 'checking', savings: 'savings' };
        const [existing] = await sql`SELECT id FROM cc_accounts WHERE source_id = ${acct.id} AND source = 'mercury'`;
        if (existing) {
          await sql`UPDATE cc_accounts SET current_balance = ${acct.currentBalance}, last_synced_at = NOW() WHERE id = ${existing.id}`;
        } else {
          await sql`
            INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, last_synced_at, metadata)
            VALUES ('mercury', ${acct.id}, ${acct.name}, ${typeMap[acct.kind] || 'checking'}, 'Mercury', ${acct.currentBalance}, NOW(),
                    ${JSON.stringify({ mercury_org: org.slug, mercury_kind: acct.kind })}::jsonb)
          `;
        }
      }
    }

    // Sync transactions for this org's accounts
    const orgAccounts = await sql`
      SELECT id, source_id FROM cc_accounts WHERE source = 'mercury' AND metadata->>'mercury_org' = ${org.slug}
    `;

    for (const acct of orgAccounts) {
      const cursor = await env.COMMAND_KV.get(`mercury:cursor:${acct.source_id}`);
      const start = (cursor as string) || '2024-01-01';

      const txResult = await mercury.getTransactions(acct.source_id as string, { start, limit: 500 });
      if (!txResult?.transactions) continue;

      const txIds = txResult.transactions.map((tx) => tx.id);
      const existingRows = txIds.length > 0
        ? await sql`SELECT source_id FROM cc_transactions WHERE source = 'mercury' AND source_id = ANY(${txIds})`
        : [];
      const existingIds = new Set(existingRows.map((r: any) => r.source_id));

      for (const tx of txResult.transactions) {
        if (existingIds.has(tx.id) || tx.status === 'cancelled') continue;
        const direction = tx.amount >= 0 ? 'inflow' : 'outflow';
        const txDate = tx.postedAt ? tx.postedAt.split('T')[0] : tx.createdAt.split('T')[0];
        await sql`
          INSERT INTO cc_transactions (account_id, source, source_id, amount, direction, description, counterparty, tx_date, posted_at)
          VALUES (${acct.id}, 'mercury', ${tx.id}, ${Math.abs(tx.amount)}, ${direction},
                  ${tx.externalMemo || tx.bankDescription || tx.counterpartyName},
                  ${tx.counterpartyNickname || tx.counterpartyName || null},
                  ${txDate}, ${tx.postedAt || null})
          ON CONFLICT DO NOTHING
        `;
        recordsSynced++;
      }

      if (txResult.transactions.length > 0) {
        const latestDate = txResult.transactions.map((tx) => tx.postedAt || tx.createdAt).sort().pop();
        if (latestDate) await env.COMMAND_KV.put(`mercury:cursor:${acct.source_id}`, latestDate.split('T')[0]);
      }
    }
  }

  return recordsSynced;
}
