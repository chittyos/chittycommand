import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';

export const credentialRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Credentials Proxy (allowlisted, audited) ────────────────

credentialRoutes.post('/get', async (c) => {
  const env = c.env;
  const connectUrl = env.CHITTYCONNECT_URL;
  if (!connectUrl) return c.json({ error: 'ChittyConnect not configured' }, 503);

  const body = await c.req.json().catch(() => ({}));
  const ref = String(body?.ref || '').trim();
  const reason = (body?.reason as string | undefined) || undefined;
  const target = (body?.target as string | undefined) || undefined;
  if (!ref) return c.json({ error: 'Missing field: ref' }, 400);

  // Allowlist check from KV (array of patterns). Patterns ending with * are treated as prefix matches.
  const allowRaw = await env.COMMAND_KV.get('credentials:allowlist');
  let allow: string[] = [];
  if (allowRaw) {
    try { allow = JSON.parse(allowRaw) as string[]; } catch { /* ignore */ }
  }
  const isAllowed = (value: string) => allow.some((pat) => pat.endsWith('*') ? value.startsWith(pat.slice(0, -1)) : value === pat);
  if (allow.length === 0 || !isAllowed(ref)) {
    return c.json({ error: 'Ref not allowlisted' }, 403);
  }

  // Per-token/subject allowlist + rate limiting
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const subjectBase = (c.get('userId') as string | undefined) || 'anonymous';
  const subject = subjectBase === 'bridge-service' ? 'svc:bridge-service' : `usr:${subjectBase}`;

  // Subject allowlist (optional)
  const subjAllowRaw = await env.COMMAND_KV.get('credentials:subject_allowlist');
  let subjAllow: string[] = [];
  if (subjAllowRaw) { try { subjAllow = JSON.parse(subjAllowRaw) as string[]; } catch { /* ignore */ } }

  // Token allowlist (sha256 hex) (optional)
  const tokAllowRaw = await env.COMMAND_KV.get('credentials:token_allowlist');
  let tokAllow: string[] = [];
  if (tokAllowRaw) { try { tokAllow = JSON.parse(tokAllowRaw) as string[]; } catch { /* ignore */ } }

  async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  let tokenHash = '';
  if (token) { tokenHash = await sha256Hex(token); }

  if ((subjAllow.length > 0 && !subjAllow.includes(subject)) && (tokAllow.length > 0 && (!tokenHash || !tokAllow.includes(tokenHash)))) {
    return c.json({ error: 'Token/subject not allowlisted' }, 403);
  }

  // Rate limit (per minute per subject/hash)
  const rateRaw = await env.COMMAND_KV.get('credentials:rate_limit');
  const limit = rateRaw ? Math.max(1, parseInt(rateRaw)) : 12;
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `rate:cred:${tokenHash || subject}:${Math.floor(now / 60)}`;
  let count = 0;
  const existing = await env.COMMAND_KV.get(windowKey);
  if (existing) { count = parseInt(existing) || 0; }
  if (count >= limit) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  await env.COMMAND_KV.put(windowKey, String(count + 1), { expirationTtl: 70 });

  // Fetch from ChittyConnect
  try {
    const headers: Record<string, string> = { 'X-Source-Service': 'chittycommand' };
    if (env.CHITTY_CONNECT_TOKEN) headers['Authorization'] = `Bearer ${env.CHITTY_CONNECT_TOKEN}`;
    const res = await fetch(`${connectUrl}/api/credentials/${encodeURIComponent(ref)}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    const sql = getDb(env);
    const reqPayload = { ref: ref.replace(/.(?=.{4}$)/g, '*'), reason, target }; // redact all but last 4

    if (!res.ok) {
      await sql`INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, status, metadata)
        VALUES ('credentials_fetch', 'chittyconnect', 'Credential fetch failed', ${JSON.stringify(reqPayload)}::jsonb, 'error', ${JSON.stringify({ code: res.status })}::jsonb)`;
      return c.json({ error: 'Credential fetch failed', code: res.status }, 502);
    }

    const data = await res.json().catch(() => ({})) as { value?: string; ttl?: number; expires_at?: string };
    // Audit success without sensitive fields
    await sql`INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
      VALUES ('credentials_fetch', 'chittyconnect', 'Credential fetch', ${JSON.stringify(reqPayload)}::jsonb, ${JSON.stringify({ redacted: true })}::jsonb, 'success')`;

    return c.json({ value: data.value, ttl: data.ttl, expires_at: data.expires_at });
  } catch (err) {
    return c.json({ error: 'Credential fetch error', detail: String(err) }, 500);
  }
});
