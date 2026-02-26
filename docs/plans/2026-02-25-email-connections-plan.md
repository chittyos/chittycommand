# Email Account Connections — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users connect email accounts (Gmail OAuth, forwarding to nick@chitty.cc) to their ChittyCommand dashboard, leveraging ChittyRouter's existing email infrastructure.

**Architecture:** ChittyRouter-centric — ChittyRouter owns email connectivity (OAuth, Gmail API polling, email parsing). ChittyCommand manages connection metadata in `cc_email_connections` and provides the Settings UI. Credentials stored in ChittyConnect, never locally.

**Tech Stack:** Hono TypeScript, Neon PostgreSQL, React + Tailwind, Cloudflare Workers/KV, ChittyRouter email workers

**Design doc:** `docs/plans/2026-02-25-email-connections-design.md`

---

### Task 1: Database Migration 0009

**Files:**
- Create: `migrations/0009_email_connections.sql`

**Step 1: Write the migration**

```sql
-- Email account connections (per-user, multi-account)
CREATE TABLE cc_email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email_address TEXT NOT NULL,
  display_name TEXT,
  connect_ref TEXT,
  namespace TEXT,
  status TEXT DEFAULT 'pending',
  last_synced_at TIMESTAMPTZ,
  error_message TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_cc_email_conn_email_user ON cc_email_connections(email_address, user_id);
CREATE INDEX idx_cc_email_conn_user ON cc_email_connections(user_id);
CREATE INDEX idx_cc_email_conn_namespace ON cc_email_connections(namespace);

-- User namespace mapping (nick -> nick@chitty.cc)
CREATE TABLE cc_user_namespaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 2: Run migration via Neon MCP**

Use `mcp__Neon__run_sql` with project `cool-bar-13270800` to execute the migration.

**Step 3: Verify tables exist**

Use `mcp__Neon__get_database_tables` to confirm `cc_email_connections` and `cc_user_namespaces` appear.

**Step 4: Commit**

```bash
git add migrations/0009_email_connections.sql
git commit -m "feat: add email connections migration (0009)"
```

---

### Task 2: Zod Validators

**Files:**
- Modify: `src/lib/validators.ts` (append after Revenue Sources section, ~line 218)

**Step 1: Add email connection schemas**

Append to `src/lib/validators.ts`:

```typescript
// ── Email Connections ──────────────────────────────────────

export const createEmailConnectionSchema = z.object({
  provider: z.enum(['gmail', 'outlook', 'forwarding']),
  email_address: z.string().email(),
  display_name: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const updateEmailConnectionSchema = z.object({
  display_name: z.string().max(100).optional(),
  status: z.enum(['active', 'disconnected']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const claimNamespaceSchema = z.object({
  namespace: z.string()
    .min(2).max(30)
    .regex(/^[a-z][a-z0-9._-]*$/, 'Must start with a letter; only lowercase letters, numbers, dots, hyphens, underscores'),
});
```

**Step 2: Commit**

```bash
git add src/lib/validators.ts
git commit -m "feat: add Zod schemas for email connections"
```

---

### Task 3: API Routes

**Files:**
- Create: `src/routes/email-connections.ts`
- Modify: `src/index.ts` (add import + route mount at ~line 21 and ~line 103)

**Step 1: Create the route file**

Create `src/routes/email-connections.ts`:

```typescript
import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import {
  createEmailConnectionSchema,
  updateEmailConnectionSchema,
  claimNamespaceSchema,
} from '../lib/validators';

export const emailConnectionRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// GET /api/email-connections — list user's connections
emailConnectionRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const userId = c.get('userId');

  const connections = await sql`
    SELECT * FROM cc_email_connections
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;

  const [ns] = await sql`
    SELECT namespace FROM cc_user_namespaces WHERE user_id = ${userId}
  `;

  return c.json({
    connections,
    namespace: ns ? `${(ns as { namespace: string }).namespace}@chitty.cc` : null,
  });
});

// POST /api/email-connections/namespace — claim a namespace (nick@chitty.cc)
emailConnectionRoutes.post('/namespace', async (c) => {
  const userId = c.get('userId');
  const raw = await c.req.json();
  const parsed = claimNamespaceSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const { namespace } = parsed.data;

  // Check if namespace already taken
  const [existing] = await sql`
    SELECT user_id FROM cc_user_namespaces WHERE namespace = ${namespace}
  `;
  if (existing && (existing as { user_id: string }).user_id !== userId) {
    return c.json({ error: 'Namespace already taken' }, 409);
  }

  // Upsert namespace
  await sql`
    INSERT INTO cc_user_namespaces (user_id, namespace)
    VALUES (${userId}, ${namespace})
    ON CONFLICT (user_id) DO UPDATE SET namespace = ${namespace}
  `;

  // Sync to ChittyRouter KV for email routing lookup
  if (c.env.CHITTYROUTER_URL) {
    try {
      const token = await c.env.COMMAND_KV.get('scrape:service_token');
      await fetch(`${c.env.CHITTYROUTER_URL}/api/namespace-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify({ namespace, user_id: userId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn('[email-connections] Failed to sync namespace to ChittyRouter:', err);
    }
  }

  return c.json({ namespace: `${namespace}@chitty.cc` }, 201);
});

// POST /api/email-connections — register a forwarding connection
emailConnectionRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const raw = await c.req.json();
  const parsed = createEmailConnectionSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const data = parsed.data;

  // Get user's namespace for forwarding connections
  let namespace: string | null = null;
  if (data.provider === 'forwarding') {
    const [ns] = await sql`SELECT namespace FROM cc_user_namespaces WHERE user_id = ${userId}`;
    namespace = ns ? (ns as { namespace: string }).namespace : null;
  }

  const [conn] = await sql`
    INSERT INTO cc_email_connections (user_id, provider, email_address, display_name, namespace, status, config)
    VALUES (${userId}, ${data.provider}, ${data.email_address}, ${data.display_name || null},
            ${namespace}, 'active', ${JSON.stringify(data.config || {})}::jsonb)
    RETURNING *
  `;

  return c.json(conn, 201);
});

// POST /api/email-connections/gmail — initiate Gmail OAuth via ChittyRouter
emailConnectionRoutes.post('/gmail', async (c) => {
  const userId = c.get('userId');

  if (!c.env.CHITTYROUTER_URL) {
    return c.json({ error: 'ChittyRouter not configured' }, 503);
  }

  const token = await c.env.COMMAND_KV.get('scrape:service_token');
  const callbackUrl = `${c.req.header('origin') || 'https://app.command.chitty.cc'}/settings?gmail_callback=true`;

  const res = await fetch(`${c.env.CHITTYROUTER_URL}/auth/gmail/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Source-Service': 'chittycommand',
    },
    body: JSON.stringify({ user_id: userId, callback_url: callbackUrl }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'OAuth initiation failed' }));
    return c.json(err, res.status as 400 | 500);
  }

  const result = await res.json() as { auth_url: string };
  return c.json(result);
});

// POST /api/email-connections/gmail/callback — complete Gmail OAuth
emailConnectionRoutes.post('/gmail/callback', async (c) => {
  const userId = c.get('userId');
  const { code, connect_ref, email_address, display_name } = await c.req.json();

  if (!connect_ref || !email_address) {
    return c.json({ error: 'Missing connect_ref or email_address from OAuth callback' }, 400);
  }

  const sql = getDb(c.env);

  const [conn] = await sql`
    INSERT INTO cc_email_connections (user_id, provider, email_address, display_name, connect_ref, status)
    VALUES (${userId}, 'gmail', ${email_address}, ${display_name || null}, ${connect_ref}, 'active')
    ON CONFLICT (email_address, user_id) DO UPDATE SET
      connect_ref = ${connect_ref},
      status = 'active',
      error_message = NULL,
      updated_at = NOW()
    RETURNING *
  `;

  return c.json(conn, 201);
});

// DELETE /api/email-connections/:id — disconnect an account
emailConnectionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const sql = getDb(c.env);

  const [conn] = await sql`
    UPDATE cc_email_connections
    SET status = 'disconnected', updated_at = NOW()
    WHERE id = ${id}::uuid AND user_id = ${userId}
    RETURNING *
  `;

  if (!conn) return c.json({ error: 'Connection not found' }, 404);
  return c.json(conn);
});

// POST /api/email-connections/:id/sync — trigger manual sync
emailConnectionRoutes.post('/:id/sync', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const sql = getDb(c.env);

  const [conn] = await sql`
    SELECT * FROM cc_email_connections
    WHERE id = ${id}::uuid AND user_id = ${userId} AND status = 'active'
  `;
  if (!conn) return c.json({ error: 'Connection not found or inactive' }, 404);

  // Trigger sync via ChittyRouter
  if (c.env.CHITTYROUTER_URL && (conn as { provider: string }).provider === 'gmail') {
    try {
      const token = await c.env.COMMAND_KV.get('scrape:service_token');
      await fetch(`${c.env.CHITTYROUTER_URL}/email/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify({
          connect_ref: (conn as { connect_ref: string }).connect_ref,
          user_id: userId,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      console.error('[email-connections] sync trigger failed:', err);
      return c.json({ error: 'Sync trigger failed' }, 502);
    }
  }

  await sql`
    UPDATE cc_email_connections SET last_synced_at = NOW() WHERE id = ${id}::uuid
  `;

  return c.json({ status: 'sync_triggered' });
});
```

**Step 2: Mount routes in index.ts**

Add import at ~line 21:
```typescript
import { emailConnectionRoutes } from './routes/email-connections';
```

Add route mount after line 103 (revenue route):
```typescript
app.route('/api/email-connections', emailConnectionRoutes);
```

**Step 3: Commit**

```bash
git add src/routes/email-connections.ts src/index.ts
git commit -m "feat: add email connections API routes"
```

---

### Task 4: Frontend API Client

**Files:**
- Modify: `ui/src/lib/api.ts` (add types + methods)

**Step 1: Add types and API methods**

Add types near the top (after existing interfaces):

```typescript
export interface EmailConnection {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'forwarding';
  email_address: string;
  display_name: string | null;
  connect_ref: string | null;
  namespace: string | null;
  status: string;
  last_synced_at: string | null;
  error_message: string | null;
  config: Record<string, unknown>;
  created_at: string;
}
```

Add methods to the `api` object:

```typescript
// Email Connections
getEmailConnections: () =>
  request<{ connections: EmailConnection[]; namespace: string | null }>('/email-connections'),

claimNamespace: (namespace: string) =>
  request<{ namespace: string }>('/email-connections/namespace', {
    method: 'POST', body: JSON.stringify({ namespace }),
  }),

addForwardingConnection: (email_address: string, display_name?: string) =>
  request<EmailConnection>('/email-connections', {
    method: 'POST',
    body: JSON.stringify({ provider: 'forwarding', email_address, display_name }),
  }),

initiateGmailOAuth: () =>
  request<{ auth_url: string }>('/email-connections/gmail', { method: 'POST' }),

completeGmailOAuth: (data: { connect_ref: string; email_address: string; display_name?: string }) =>
  request<EmailConnection>('/email-connections/gmail/callback', {
    method: 'POST', body: JSON.stringify(data),
  }),

disconnectEmail: (id: string) =>
  request<EmailConnection>(`/email-connections/${id}`, { method: 'DELETE' }),

syncEmailConnection: (id: string) =>
  request<{ status: string }>(`/email-connections/${id}/sync`, { method: 'POST' }),
```

**Step 2: Commit**

```bash
git add ui/src/lib/api.ts
git commit -m "feat: add email connection API client methods"
```

---

### Task 5: Settings UI — Email Accounts Section

**Files:**
- Modify: `ui/src/pages/Settings.tsx` (add Email Accounts section)

**Step 1: Add state and effects**

Add to existing state declarations:
```typescript
const [emailConnections, setEmailConnections] = useState<EmailConnection[]>([]);
const [emailNamespace, setEmailNamespace] = useState<string | null>(null);
const [namespaceClaim, setNamespaceClaim] = useState('');
const [emailLoading, setEmailLoading] = useState(false);
```

Add to existing `useEffect`:
```typescript
api.getEmailConnections().then((r) => {
  setEmailConnections(r.connections);
  setEmailNamespace(r.namespace);
}).catch((e) => console.error('[Settings] email connections failed:', e));
```

**Step 2: Add handler functions**

```typescript
const claimNamespace = async () => {
  if (!namespaceClaim.trim()) return;
  setEmailLoading(true);
  try {
    const result = await api.claimNamespace(namespaceClaim.trim().toLowerCase());
    setEmailNamespace(result.namespace);
    setNamespaceClaim('');
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Failed to claim namespace');
  } finally {
    setEmailLoading(false);
  }
};

const connectGmail = async () => {
  setEmailLoading(true);
  try {
    const result = await api.initiateGmailOAuth();
    window.open(result.auth_url, '_blank', 'width=600,height=700');
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Gmail OAuth failed');
  } finally {
    setEmailLoading(false);
  }
};

const disconnectEmail = async (id: string) => {
  try {
    await api.disconnectEmail(id);
    setEmailConnections((prev) => prev.map((c) =>
      c.id === id ? { ...c, status: 'disconnected' } : c
    ));
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Disconnect failed');
  }
};

const syncEmail = async (id: string) => {
  try {
    await api.syncEmailConnection(id);
    setEmailConnections((prev) => prev.map((c) =>
      c.id === id ? { ...c, last_synced_at: new Date().toISOString() } : c
    ));
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Sync failed');
  }
};
```

**Step 3: Add JSX section**

Add after the existing "Bank Account Linking" section and before the sync status table. The section should include:

1. **Namespace claim** — input + button if no namespace claimed yet, or display `nick@chitty.cc` with copy button if claimed
2. **Connect Gmail** button
3. **Connection list** — table of connected accounts with provider icon, email, status badge, last sync time, sync button, disconnect button

Use existing `Card` and `ActionButton` components from the project.

**Step 4: Commit**

```bash
git add ui/src/pages/Settings.tsx
git commit -m "feat: add email accounts section to Settings UI"
```

---

### Task 6: Build, Deploy, Verify

**Step 1: Build frontend**

```bash
npm run ui:build
```

**Step 2: Deploy worker**

```bash
npm run deploy
```

**Step 3: Verify migration**

Use Neon MCP `get_database_tables` to confirm tables exist.

**Step 4: Verify API**

```bash
curl -s https://command.chitty.cc/health | jq .
```

**Step 5: Commit any build artifacts if needed and push**

```bash
git push
```

---

### Task 7: ChittyRouter — Dynamic Account Config (separate repo)

> **Note:** This task is in the ChittyRouter repo at `/Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyrouter/`

**Files:**
- Modify: `src/email/inbox-monitor.js` — read account list from KV instead of hardcoded array
- Modify: `src/email/gmail-token-manager.js` — support dynamic account registration via KV
- Modify: `src/email/cloudflare-email-handler.js` — replace hardcoded `addressRoutes` with KV lookup
- Modify: `src/unified-worker.js` — add `/auth/gmail/connect`, `/api/namespace-sync`, `/email/sync` routes

**This task requires a separate planning session** since it modifies a different service repo. The ChittyCommand side (Tasks 1-6) is fully functional as a standalone — it stores connection metadata and shows the UI. The ChittyRouter side enables the actual email polling and OAuth flow.

---

## Summary

| Task | What | Files | Commit message |
|------|------|-------|----------------|
| 1 | Migration 0009 | `migrations/0009_email_connections.sql` | `feat: add email connections migration (0009)` |
| 2 | Zod validators | `src/lib/validators.ts` | `feat: add Zod schemas for email connections` |
| 3 | API routes | `src/routes/email-connections.ts`, `src/index.ts` | `feat: add email connections API routes` |
| 4 | Frontend API client | `ui/src/lib/api.ts` | `feat: add email connection API client methods` |
| 5 | Settings UI | `ui/src/pages/Settings.tsx` | `feat: add email accounts section to Settings UI` |
| 6 | Build + Deploy | — | push |
| 7 | ChittyRouter changes | Separate repo | Separate planning session |
