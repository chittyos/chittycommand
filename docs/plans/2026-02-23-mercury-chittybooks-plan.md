# Mercury + ChittyBooks + ChittyAssets Live Data Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire live Mercury financial data into ChittyCommand, connect ChittyBooks for transaction bookkeeping, and integrate ChittyAssets for bidirectional property/asset data sync.

**Architecture:** Direct Mercury API client with multi-org token management via KV (refreshed from ChittyConnect). ChittyBooks client for pushing executed actions as bookkeeping entries. ChittyAssets client for reading property data and pushing action results to its evidence ledger. All integrate through the existing bridge routes pattern.

**Tech Stack:** Hono TypeScript, Cloudflare Workers KV, Mercury REST API, ChittyBooks REST API, ChittyAssets REST API, Neon PostgreSQL

---

### Task 1: Add Mercury Client to Integrations

**Files:**
- Modify: `src/lib/integrations.ts` (append after `connectClient` at line 306)

**Step 1: Add Mercury types and client**

Add the following after the `connectClient` function (line 306) in `src/lib/integrations.ts`:

```typescript
// ── Mercury ─────────────────────────────────────────────────
// Direct Mercury API for multi-entity banking

export interface MercuryAccount {
  id: string;
  name: string;
  status: string;
  type: string;
  routingNumber: string;
  accountNumber: string;
  currentBalance: number;
  availableBalance: number;
  kind: string;
}

export interface MercuryTransaction {
  id: string;
  amount: number;
  bankDescription: string | null;
  counterpartyId: string;
  counterpartyName: string;
  counterpartyNickname: string | null;
  createdAt: string;
  dashboardLink: string;
  details: Record<string, unknown> | null;
  estimatedDeliveryDate: string;
  externalMemo: string | null;
  kind: string;
  note: string | null;
  postedAt: string | null;
  status: string;
}

export function mercuryClient(token: string) {
  const baseUrl = 'https://api.mercury.com/api/v1';

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        console.error(`[mercury] ${path} failed: ${res.status}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[mercury] ${path} error:`, err);
      return null;
    }
  }

  return {
    getAccounts: () => get<{ accounts: MercuryAccount[] }>('/accounts'),

    getTransactions: (accountId: string, params?: { offset?: number; limit?: number; start?: string; end?: string }) => {
      const qs = params ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
      ).toString() : '';
      return get<{ transactions: MercuryTransaction[] }>(`/account/${accountId}/transactions${qs}`);
    },
  };
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to Mercury types

**Step 3: Commit**

```bash
git add src/lib/integrations.ts
git commit -m "feat: add Mercury API client to integrations"
```

---

### Task 2: Add ChittyBooks Client to Integrations

**Files:**
- Modify: `src/lib/integrations.ts` (append after Mercury client)
- Modify: `src/index.ts` (add `CHITTYBOOKS_URL` to Env type, line 30)

**Step 1: Add CHITTYBOOKS_URL to Env type**

In `src/index.ts`, add `CHITTYBOOKS_URL` to the `Env` type after line 30 (`CHITTYCONNECT_URL`):

```typescript
  CHITTYBOOKS_URL?: string;
```

**Step 2: Add ChittyBooks client**

Append to `src/lib/integrations.ts` after the Mercury client:

```typescript
// ── ChittyBooks ─────────────────────────────────────────────
// Bookkeeping and accounting: push executed actions as ledger entries

export function booksClient(env: Env) {
  const baseUrl = env.CHITTYBOOKS_URL;
  if (!baseUrl) return null;

  return {
    getSummary: async (): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/summary`, {
          headers: { 'X-Source-Service': 'chittycommand' },
        });
        if (!res.ok) return null;
        return await res.json() as Record<string, unknown>;
      } catch (err) {
        console.error('[books] summary error:', err);
        return null;
      }
    },

    recordTransaction: async (payload: { type: 'income' | 'expense'; description: string; amount: number }): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/transaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.error(`[books] record-transaction failed: ${res.status}`);
          return null;
        }
        return await res.json() as Record<string, unknown>;
      } catch (err) {
        console.error('[books] record-transaction error:', err);
        return null;
      }
    },
  };
}
```

**Step 3: Add CHITTYBOOKS_URL to wrangler.toml**

In `wrangler.toml`, add under `[vars]` after `PLAID_ENV`:

```toml
CHITTYBOOKS_URL = "https://chittybooks.chitty.cc"
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/lib/integrations.ts src/index.ts wrangler.toml
git commit -m "feat: add ChittyBooks client for bookkeeping integration"
```

---

### Task 3: Add Mercury Bridge Routes

**Files:**
- Modify: `src/routes/bridge.ts` (add Mercury section before Cross-Service Status, line 356)

**Step 1: Update imports in bridge.ts**

At line 4 in `src/routes/bridge.ts`, add `mercuryClient` and `connectClient` to the import:

```typescript
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient } from '../lib/integrations';
```

**Step 2: Add Mercury bridge routes**

Insert before the `// ── Cross-Service Status` comment (line 356) in `src/routes/bridge.ts`:

```typescript
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
        // Try fetching from ChittyConnect (1Password proxy)
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
        // Check if we have a cached token already
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

  // Group accounts by mercury_org to match tokens
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
      // Get incremental sync cursor (last synced date)
      const cursor = await c.env.COMMAND_KV.get(`mercury:cursor:${acct.sourceId}`);
      const start = cursor || '2024-01-01';

      const result = await mercury.getTransactions(acct.sourceId, { start, limit: 500 });
      if (!result?.transactions) continue;

      // Pre-fetch existing transaction IDs to avoid N+1
      const txIds = result.transactions.map((tx) => tx.id);
      const existingRows = txIds.length > 0
        ? await sql`SELECT source_id FROM cc_transactions WHERE source = 'mercury' AND source_id = ANY(${txIds})`
        : [];
      const existingIds = new Set(existingRows.map((r: any) => r.source_id));

      for (const tx of result.transactions) {
        if (existingIds.has(tx.id)) continue;
        if (tx.status === 'cancelled') continue;

        // Mercury: positive = credit (inflow), negative = debit (outflow)
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

      // Update cursor to latest transaction date
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
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/routes/bridge.ts
git commit -m "feat: add Mercury bridge routes (refresh-tokens, sync-accounts, sync-transactions)"
```

---

### Task 4: Add ChittyBooks Bridge Routes

**Files:**
- Modify: `src/routes/bridge.ts` (add ChittyBooks section after Mercury, before Cross-Service Status)

**Step 1: Add booksClient import**

Update the import at line 4 of `src/routes/bridge.ts` to include `booksClient`:

```typescript
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient, booksClient } from '../lib/integrations';
```

**Step 2: Add ChittyBooks bridge routes**

Insert after the Mercury section, before Cross-Service Status:

```typescript
// ── ChittyBooks ─────────────────────────────────────────────

/** Record a transaction in ChittyBooks for bookkeeping */
bridgeRoutes.post('/books/record-transaction', async (c) => {
  const books = booksClient(c.env);
  if (!books) return c.json({ error: 'ChittyBooks not configured' }, 503);

  const body = await c.req.json() as { type: 'income' | 'expense'; description: string; amount: number };
  if (!body.type || !body.description || !body.amount) {
    return c.json({ error: 'type, description, and amount are required' }, 400);
  }

  const result = await books.recordTransaction(body);
  if (!result) return c.json({ error: 'Failed to record transaction in ChittyBooks' }, 502);

  // Also log the action
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
```

**Step 3: Add Mercury to the bridge status endpoint**

In the `bridgeRoutes.get('/status', ...)` handler, add Mercury and ChittyBooks to the services array:

```typescript
    { name: 'chittybooks', url: c.env.CHITTYBOOKS_URL },
    { name: 'mercury', url: 'https://api.mercury.com' },
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/routes/bridge.ts
git commit -m "feat: add ChittyBooks bridge routes (record-transaction, summary)"
```

---

### Task 5: Wire Mercury into Cron Pipeline

**Files:**
- Modify: `src/lib/cron.ts` (add Mercury sync before Plaid, lines 41-54)

**Step 1: Add mercuryClient and connectClient imports**

At line 3 of `src/lib/cron.ts`, add to the import:

```typescript
import { plaidClient, financeClient, mercuryClient, connectClient } from './integrations';
```

**Step 2: Add syncMercury function**

Append after the `syncFinance` function (after line 233) in `src/lib/cron.ts`:

```typescript
/**
 * Refresh Mercury tokens from ChittyConnect, then sync accounts and transactions.
 * Each org syncs independently — a failed org doesn't block others.
 */
async function syncMercury(env: Env, sql: NeonQueryFunction<false, false>): Promise<number> {
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
```

**Step 3: Wire syncMercury into the daily_api cron**

In `src/lib/cron.ts`, inside the `if (source === 'daily_api')` block (around line 41), add Mercury as Phase 0 (before Plaid):

Replace lines 42-47 with:

```typescript
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
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/lib/cron.ts
git commit -m "feat: wire Mercury multi-org sync into daily cron pipeline"
```

---

### Task 6: Deploy and Verify

**Files:**
- No file changes — deployment and verification only

**Step 1: Deploy to Cloudflare Workers**

Run: `npx wrangler deploy`
Expected: Successful deploy with updated bindings showing `CHITTYBOOKS_URL`

**Step 2: Verify health**

Run: `curl -s https://command.chitty.cc/health | jq .`
Expected: `{"status":"ok","service":"chittycommand",...}`

**Step 3: Check bridge status**

Run: `curl -s -H "Authorization: Bearer TOKEN" https://command.chitty.cc/api/bridge/status | jq .`
Expected: Response showing Mercury and ChittyBooks in service list (both will show `not_configured` or `unreachable` until tokens are seeded and ChittyBooks is deployed)

**Step 4: Commit deploy confirmation**

No code to commit — deployment is live.

---

### Task 7: Seed Mercury Org Config in KV

**Files:**
- No file changes — KV configuration only

**Step 1: Seed mercury:orgs in KV**

This is a manual step. The user needs to populate the `mercury:orgs` KV key with their org list:

```bash
npx wrangler kv key put --binding COMMAND_KV "mercury:orgs" '[{"slug":"aribia-mgmt","opRef":"op://ChittyVault/mercury-aribia-mgmt/token"},{"slug":"personal","opRef":"op://ChittyVault/mercury-personal/token"}]'
```

The exact slugs and 1Password references depend on the user's setup.

**Step 2: Manually seed a test token (optional)**

For testing before ChittyConnect is available:

```bash
npx wrangler kv key put --binding COMMAND_KV "mercury:token:personal" "REDACTED_TOKEN_HERE"
```

**Step 3: Test manual sync**

```bash
curl -X POST -H "Authorization: Bearer TOKEN" https://command.chitty.cc/api/bridge/mercury/sync-accounts | jq .
```

Expected: `{"orgs":N,"created":N,"updated":0,"errors":[]}`

**Step 4: Test transaction sync**

```bash
curl -X POST -H "Authorization: Bearer TOKEN" https://command.chitty.cc/api/bridge/mercury/sync-transactions | jq .
```

Expected: `{"accounts":N,"transactions_added":N,"errors":[]}`

---

### Task 8: Add ChittyAssets Client to Integrations

**Files:**
- Modify: `src/lib/integrations.ts` (append after ChittyBooks client)
- Modify: `src/index.ts` (add `CHITTYASSETS_URL` to Env type)
- Modify: `wrangler.toml` (add `CHITTYASSETS_URL` env var)

**Step 1: Add CHITTYASSETS_URL to Env type**

In `src/index.ts`, add to the Env type after `CHITTYBOOKS_URL`:

```typescript
  CHITTYASSETS_URL?: string;
```

**Step 2: Add ChittyAssets client**

Append to `src/lib/integrations.ts` after the ChittyBooks client:

```typescript
// ── ChittyAssets ────────────────────────────────────────────
// Asset management: property data, ownership proof, evidence ledger

export function assetsClient(env: Env) {
  const baseUrl = env.CHITTYASSETS_URL;
  if (!baseUrl) return null;

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { 'X-Source-Service': 'chittycommand' },
      });
      if (!res.ok) return null;
      return await res.json() as T;
    } catch (err) {
      console.error(`[assets] ${path} error:`, err);
      return null;
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[assets] ${path} failed: ${res.status}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[assets] ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Fetch all assets for the authenticated user */
    getAssets: () => get<Record<string, unknown>[]>('/api/assets'),

    /** Fetch a single asset by ID */
    getAsset: (assetId: string) => get<Record<string, unknown>>(`/api/assets/${encodeURIComponent(assetId)}`),

    /** Submit evidence to the ChittyAssets evidence ledger */
    submitEvidence: (payload: { evidenceType: string; data: Record<string, unknown>; metadata?: Record<string, unknown> }) =>
      post<{ chittyId: string; status: string; trustScore: number }>('/api/evidence-ledger/submit', payload),

    /** Get ChittyOS ecosystem service status */
    getServiceStatus: () => get<Record<string, unknown>[]>('/api/chitty/services'),
  };
}
```

**Step 3: Add CHITTYASSETS_URL to wrangler.toml**

In `wrangler.toml`, add under `[vars]` after `CHITTYBOOKS_URL`:

```toml
CHITTYASSETS_URL = "https://chittyassets.chitty.cc"
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/lib/integrations.ts src/index.ts wrangler.toml
git commit -m "feat: add ChittyAssets client for property/asset data and evidence ledger"
```

---

### Task 9: Add ChittyAssets Bridge Routes

**Files:**
- Modify: `src/routes/bridge.ts` (add ChittyAssets section after ChittyBooks, before Cross-Service Status)

**Step 1: Add assetsClient import**

Update the import in `src/routes/bridge.ts` to include `assetsClient`:

```typescript
import { ledgerClient, financeClient, plaidClient, mercuryClient, connectClient, booksClient, assetsClient } from '../lib/integrations';
```

**Step 2: Add ChittyAssets bridge routes**

Insert after the ChittyBooks section, before Cross-Service Status:

```typescript
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

  const body = await c.req.json() as { evidenceType: string; data: Record<string, unknown>; metadata?: Record<string, unknown> };
  if (!body.evidenceType || !body.data) {
    return c.json({ error: 'evidenceType and data are required' }, 400);
  }

  const result = await assets.submitEvidence({
    evidenceType: body.evidenceType,
    data: body.data,
    metadata: { ...body.metadata, submissionSource: 'ChittyCommand' },
  });

  if (!result) return c.json({ error: 'Failed to submit evidence to ChittyAssets' }, 502);

  // Log the action
  const sql = getDb(c.env);
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
    VALUES ('assets_evidence', 'evidence', ${body.evidenceType}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb, 'completed')
  `;

  return c.json({ submitted: true, chittyId: result.chittyId, trustScore: result.trustScore });
});
```

**Step 3: Add ChittyAssets to bridge status endpoint**

In the services array of the `/status` handler, add:

```typescript
    { name: 'chittyassets', url: c.env.CHITTYASSETS_URL },
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/routes/bridge.ts
git commit -m "feat: add ChittyAssets bridge routes (sync-properties, submit-evidence)"
```

---

### Task 10: Final Deploy and Verify All Integrations

**Files:**
- No file changes — deployment and verification only

**Step 1: Deploy to Cloudflare Workers**

Run: `npx wrangler deploy`
Expected: Successful deploy with `CHITTYBOOKS_URL` and `CHITTYASSETS_URL` in bindings

**Step 2: Verify health**

Run: `curl -s https://command.chitty.cc/health | jq .`
Expected: `{"status":"ok","service":"chittycommand",...}`

**Step 3: Verify bridge status shows all services**

Run: `curl -s -H "Authorization: Bearer TOKEN" https://command.chitty.cc/api/bridge/status | jq '.services[].name'`
Expected: Should list `chittyauth`, `chittyledger`, `chittyfinance`, `chittycharge`, `chittyconnect`, `chittybooks`, `chittyassets`, `mercury`, `plaid`

**Step 4: Push to GitHub**

```bash
git push origin main
```
