import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { connectClient } from '../lib/integrations';

export const connectRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

connectRoutes.get('/connect/status', async (c) => {
  const url = c.env.CHITTYCONNECT_URL;
  if (!url) return c.json({ status: 'not_configured' });
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    return c.json({ status: res.ok ? 'ok' : 'error', code: res.status, ...data });
  } catch (err) {
    console.error('[connect/status] upstream health check failed:', err);
    return c.json({ status: 'unreachable', error: 'Upstream health check failed' });
  }
});

connectRoutes.post('/connect/discover', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const service = (body?.service as string | undefined)?.trim();
  if (!service) return c.json({ error: 'Missing field: service' }, 400);
  // Simple per-minute rate limit (KV-configurable). Subject: userId or token hash.
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const userId = c.get('userId') || 'anonymous';
  const subject = userId === 'bridge-service' ? 'svc:bridge-service' : `usr:${userId}`;
  const rateRaw = await c.env.COMMAND_KV.get('discover:rate_limit');
  const limit = rateRaw ? Math.max(1, parseInt(rateRaw)) : 60; // default 60/min
  async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const tokenHash = token ? await sha256Hex(token) : '';
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `rate:discover:${tokenHash || subject}:${Math.floor(now / 60)}`;
  const existing = await c.env.COMMAND_KV.get(windowKey);
  const count = existing ? parseInt(existing) || 0 : 0;
  if (count >= limit) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  await c.env.COMMAND_KV.put(windowKey, String(count + 1), { expirationTtl: 70 });
  const client = connectClient(c.env);
  if (!client) return c.json({ error: 'ChittyConnect not configured' }, 503);
  const url = await client.discover(service);
  if (!url) return c.json({ error: 'Service not found' }, 404);
  return c.json({ service, url });
});
