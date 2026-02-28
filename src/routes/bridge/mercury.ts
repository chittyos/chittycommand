import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { mercuryClient, connectClient } from '../../lib/integrations';

export const mercuryRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Mercury ─────────────────────────────────────────────────

interface MercuryOrg {
  slug: string;
  opRef: string;
}

/** Refresh Mercury tokens from ChittyConnect/1Password into KV */
mercuryRoutes.post('/refresh-tokens', async (c) => {
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
mercuryRoutes.post('/sync-accounts', async (c) => {
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
mercuryRoutes.post('/sync-transactions', async (c) => {
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
