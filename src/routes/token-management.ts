import { Hono } from 'hono';
import type { Env } from '../index';

export const tokenManagementRoutes = new Hono<{ Bindings: Env }>();

const LEGACY_TOKEN_KEYS = [
  'mcp:service_token',
  'bridge:service_token',
  'scrape:service_token',
] as const;

type LegacyTokenKey = (typeof LEGACY_TOKEN_KEYS)[number];

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function isAdmin(scopes: unknown): boolean {
  if (!Array.isArray(scopes)) return false;
  const s = scopes.filter((v): v is string => typeof v === 'string');
  return s.includes('admin') || s.includes('admin:*') || s.includes('chittycommand:admin');
}

function createRandomHex(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function parseUpstreamBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function getAuthBase(env: Env): string {
  return env.CHITTYAUTH_URL || 'https://auth.chitty.cc';
}

function ensureAdminScope(c: { get: (name: string) => unknown }) {
  const scopes = (c.get('scopes') as string[] | undefined) || [];
  return isAdmin(scopes);
}

tokenManagementRoutes.get('/tokens/overview', async (c) => {
  if (!ensureAdminScope(c)) return c.json({ error: 'Forbidden' }, 403);

  const authBase = getAuthBase(c.env);
  const legacy = await Promise.all(
    LEGACY_TOKEN_KEYS.map(async (key) => {
      const value = await c.env.COMMAND_KV.get(key);
      return {
        key,
        configured: Boolean(value),
        preview: value ? `${value.slice(0, 6)}...${value.slice(-4)}` : null,
      };
    }),
  );

  let authStatus: 'ok' | 'error' = 'error';
  let authCode: number | null = null;
  try {
    const res = await fetch(`${authBase}/health`, { signal: AbortSignal.timeout(2500) });
    authCode = res.status;
    authStatus = res.ok ? 'ok' : 'error';
  } catch {
    authStatus = 'error';
  }

  return c.json({
    chittyauth: {
      base_url: authBase,
      status: authStatus,
      health_code: authCode,
    },
    legacy,
  });
});

tokenManagementRoutes.post('/tokens/legacy/rotate', async (c) => {
  if (!ensureAdminScope(c)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const key = String((body as { key?: string })?.key || '') as LegacyTokenKey;
  if (!LEGACY_TOKEN_KEYS.includes(key)) {
    return c.json({ error: 'Invalid token key', allowed: LEGACY_TOKEN_KEYS }, 400);
  }

  const token = createRandomHex(32);
  await c.env.COMMAND_KV.put(key, token);

  return c.json({
    key,
    token,
    rotated_at: new Date().toISOString(),
  });
});

tokenManagementRoutes.post('/tokens/chittyauth/provision', async (c) => {
  if (!ensureAdminScope(c)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { admin_token?: string; payload?: Record<string, unknown> };
  const adminToken = (body.admin_token || '').trim() || parseBearerToken(c.req.header('Authorization')) || '';
  if (!adminToken) return c.json({ error: 'Missing admin token' }, 400);

  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
  const authBase = getAuthBase(c.env);
  const res = await fetch(`${authBase}/v1/tokens/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
      'X-Source-Service': 'chittycommand',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });

  const result = await parseUpstreamBody(res);
  return c.json({ ok: res.ok, status: res.status, result });
});

tokenManagementRoutes.post('/tokens/chittyauth/validate', async (c) => {
  if (!ensureAdminScope(c)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { token?: string };
  const token = (body.token || '').trim();
  if (!token) return c.json({ error: 'Missing token' }, 400);

  const authBase = getAuthBase(c.env);
  const res = await fetch(`${authBase}/v1/tokens/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Source-Service': 'chittycommand',
    },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });

  const result = await parseUpstreamBody(res);
  return c.json({ ok: res.ok, status: res.status, result });
});

tokenManagementRoutes.post('/tokens/chittyauth/revoke', async (c) => {
  if (!ensureAdminScope(c)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as { admin_token?: string; payload?: Record<string, unknown> };
  const adminToken = (body.admin_token || '').trim() || parseBearerToken(c.req.header('Authorization')) || '';
  if (!adminToken) return c.json({ error: 'Missing admin token' }, 400);

  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
  const authBase = getAuthBase(c.env);
  const res = await fetch(`${authBase}/v1/tokens/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
      'X-Source-Service': 'chittycommand',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });

  const result = await parseUpstreamBody(res);
  return c.json({ ok: res.ok, status: res.status, result });
});
