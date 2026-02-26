import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import {
  createEmailConnectionSchema,
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
  const { connect_ref, email_address, display_name } = await c.req.json();

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
