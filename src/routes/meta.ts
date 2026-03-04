import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';

export const metaPublicRoutes = new Hono<{ Bindings: Env }>();
export const metaRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Public: Canon info and lightweight schema refs
metaPublicRoutes.get('/canon', async (c) => {
  const env = c.env;
  const canonicalUri = 'chittycanon://core/services/chittycommand';
  const serviceId = await env.COMMAND_KV.get('register:service_id');
  const lastBeaconAt = await env.COMMAND_KV.get('register:last_beacon_at');
  const lastBeaconStatus = await env.COMMAND_KV.get('register:last_beacon_status');
  return c.json({
    name: 'ChittyCommand',
    version: '0.1.0',
    environment: env.ENVIRONMENT || 'production',
    canonicalUri,
    namespace: 'chittycanon://core/services',
    tier: 5,
    registered_with: env.CHITTYREGISTER_URL || null,
    registration: { service_id: serviceId || null, last_beacon_at: lastBeaconAt || null, last_status: lastBeaconStatus || null },
  });
});

metaPublicRoutes.get('/schema', (c) => {
  // Lightweight schema refs + canonical links (ChittySchema)
  return c.json({
    schemaVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    endpoints: [
      '/api/dashboard',
      '/api/accounts',
      '/api/obligations',
      '/api/disputes',
      '/api/recommendations',
      '/api/cashflow',
    ],
    db_tables: [
      'cc_accounts',
      'cc_obligations',
      'cc_transactions',
      'cc_recommendations',
      'cc_cashflow_projections',
      'cc_disputes',
      'cc_dispute_correspondence',
      'cc_legal_deadlines',
      'cc_documents',
      'cc_actions_log',
      'cc_sync_log',
      'cc_properties',
    ],
    canonicalRefs: {
      chittyschema_base: 'https://schema.chitty.cc/api/v1',
      list_schemas: 'https://schema.chitty.cc/api/v1/schemas',
      get_schema: 'https://schema.chitty.cc/api/v1/schemas/{type}',
      validate: 'https://schema.chitty.cc/api/v1/validate',
      drift: 'https://schema.chitty.cc/api/v1/drift',
      catalog_repo: 'https://github.com/chittyfoundation/chittyschema',
    },
    notes: 'Zod schemas are used server-side; canonical JSON Schemas are governed by chittyfoundation/chittyschema.',
  });
});

metaPublicRoutes.get('/beacon', async (c) => {
  const regAt = await c.env.COMMAND_KV.get('register:last_beacon_at');
  const regSt = await c.env.COMMAND_KV.get('register:last_beacon_status');
  const conAt = await c.env.COMMAND_KV.get('connect:last_beacon_at');
  const conSt = await c.env.COMMAND_KV.get('connect:last_beacon_status');
  return c.json({
    register: { last_beacon_at: regAt || null, last_status: regSt || null },
    connect: { last_beacon_at: conAt || null, last_status: conSt || null },
  });
});

// Certificate verification passthrough (public)
metaPublicRoutes.post('/cert/verify', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const certificateId = String(body?.certificate_id || '').trim();
    if (!certificateId) return c.json({ error: 'Missing field: certificate_id' }, 400);
    const base = c.env.CHITTYCERT_URL || 'https://cert.chitty.cc';
    const res = await fetch(`${base}/api/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
      body: JSON.stringify({ certificate_id: certificateId }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return c.json({ valid: false, result: out, code: res.status }, res.status as ContentfulStatusCode);
    return c.json(out);
  } catch (err) {
    console.error('[cert/verify] upstream request failed:', err);
    return c.json({ error: 'Certificate verification failed' }, 500);
  }
});

// Certificate fetch (public)
metaPublicRoutes.get('/cert/:id', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Missing certificate id' }, 400);
  try {
    const base = c.env.CHITTYCERT_URL || 'https://cert.chitty.cc';
    const res = await fetch(`${base}/api/v1/certificate/${encodeURIComponent(id)}`);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return c.json({ error: 'Not found', code: res.status, result: out }, res.status as ContentfulStatusCode);
    return c.json(out);
  } catch (err) {
    console.error('[cert/:id] upstream request failed:', err);
    return c.json({ error: 'Certificate fetch failed' }, 500);
  }
});

// Authenticated: identity resolution
metaRoutes.get('/whoami', (c) => {
  const userId = c.get('userId') as string | undefined;
  const scopes = (c.get('scopes') as string[] | undefined) || [];
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({
    userId,
    subjectUri: `chittyid://users/${userId}`,
    scopes,
    environment: c.env.ENVIRONMENT || 'production',
  });
});
