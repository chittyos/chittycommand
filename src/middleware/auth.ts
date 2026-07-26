import type { Context, Next } from 'hono';
import type { Env } from '../index';

export type AuthVariables = {
  userId: string;
  scopes: string[];
};

/**
 * Auth middleware for /api/* routes.
 * Checks local KV tokens first, then falls back to ChittyAuth.
 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const token = authHeader.slice(7);

  // Local KV token check
  const userId = await c.env.COMMAND_KV.get(`auth:token:${token}`);
  if (userId) {
    c.set('userId', userId);
    c.set('scopes', ['admin']);
    return next();
  }

  // ChittyAuth fallback
  const authUrl = c.env.CHITTYAUTH_URL;
  if (authUrl) {
    try {
      const res = await fetch(`${authUrl}/v1/tokens/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        const identity = await res.json() as { user_id: string; scopes: string[] };
        c.set('userId', identity.user_id);
        c.set('scopes', identity.scopes || []);
        return next();
      }
    } catch { /* fall through to 401 */ }
  }

  return c.json({ error: 'Invalid or expired token' }, 401);
}

/**
 * Bridge auth middleware for /api/bridge/* routes.
 * Accepts either a service token from KV or a regular user token.
 */
export async function bridgeAuthMiddleware(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const token = authHeader.slice(7);

  // Service token check (simple shared secret in KV)
  const serviceToken = await c.env.COMMAND_KV.get('bridge:service_token');
  if (serviceToken && token === serviceToken) {
    c.set('userId', 'bridge-service');
    c.set('scopes', ['bridge']);
    return next();
  }

  // Fall back to regular user auth
  const userId = await c.env.COMMAND_KV.get(`auth:token:${token}`);
  if (userId) {
    c.set('userId', userId);
    c.set('scopes', ['admin']);
    return next();
  }

  const authUrl = c.env.CHITTYAUTH_URL;
  if (authUrl) {
    try {
      const res = await fetch(`${authUrl}/v1/tokens/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const identity = await res.json() as { user_id: string; scopes: string[] };
        c.set('userId', identity.user_id);
        c.set('scopes', identity.scopes || []);
        return next();
      }
    } catch { /* fall through */ }
  }

  return c.json({ error: 'Invalid or expired token' }, 401);
}

/**
 * MCP auth middleware for /mcp/* routes.
 *
 * Primary: Validates the `Cf-Access-Jwt-Assertion` header forwarded by the
 * Cloudflare MCP server portal (Zero Trust AI Controls). CF handles the
 * OAuth/PKCE flow with MCP clients and injects this signed JWT. The worker
 * verifies it against CF's public JWKS endpoint.
 *
 * Fallback: KV shared-secret (`mcp:service_token`) retained for the transition
 * window while the CF portal completes first-sync.
 */
export async function mcpAuthMiddleware(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  // Dev mode bypass
  if (c.env.ENVIRONMENT !== 'production') {
    c.set('userId', 'mcp-client');
    c.set('scopes', ['mcp']);
    return next();
  }

  // ── Primary path: CF Access JWT from MCP portal ──────────────────────────
  const cfJwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (cfJwt) {
    try {
      const teamDomain = c.env.CF_TEAM_DOMAIN ?? 'chittycorp.cloudflareaccess.com';
      const jwksUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
      const aud = c.env.CF_ACCESS_AUD ?? '';

      // Fetch JWKS (cached in KV to avoid per-request fetch)
      const cacheKey = 'cf:access:jwks';
      let jwksRaw = await c.env.COMMAND_KV.get(cacheKey);
      if (!jwksRaw) {
        const jwksRes = await fetch(jwksUrl);
        if (!jwksRes.ok) throw new Error(`JWKS fetch failed: ${jwksRes.status}`);
        jwksRaw = await jwksRes.text();
        await c.env.COMMAND_KV.put(cacheKey, jwksRaw, { expirationTtl: 3600 });
      }
      const { keys } = JSON.parse(jwksRaw) as { keys: JsonWebKey[] };

      // Verify the JWT header/payload manually (no jose dep in this worker yet —
      // use the lightweight manual approach until jose is wired in)
      const [headerB64, payloadB64, sigB64] = cfJwt.split('.');
      if (!headerB64 || !payloadB64 || !sigB64) throw new Error('Malformed JWT');

      const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
      const now = Math.floor(Date.now() / 1000);

      if (payload.exp && payload.exp < now) throw new Error('JWT expired');
      if (payload.nbf && payload.nbf > now + 30) throw new Error('JWT not yet valid');
      if (aud && payload.aud) {
        const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!audList.includes(aud)) throw new Error('JWT audience mismatch');
      }

      // Signature verification via SubtleCrypto
      const enc = new TextEncoder();
      const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
      const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

      let verified = false;
      for (const jwk of keys) {
        try {
          const key = await crypto.subtle.importKey(
            'jwk', jwk as JsonWebKey,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false, ['verify']
          );
          verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, signingInput);
          if (verified) break;
        } catch { /* try next key */ }
      }
      if (!verified) throw new Error('JWT signature invalid');

      c.set('userId', payload.email ?? payload.sub ?? 'cf-mcp-client');
      c.set('scopes', ['mcp']);
      return next();
    } catch (err) {
      return c.json({ error: 'Invalid CF Access JWT', detail: String(err) }, 401);
    }
  }

  // ── Fallback: KV shared-secret (transition period) ───────────────────────
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'MCP authentication required' }, 401);
  }
  const token = authHeader.slice(7);

  const validToken = await c.env.COMMAND_KV.get('mcp:service_token');
  if (validToken && token === validToken) {
    c.set('userId', 'mcp-client');
    c.set('scopes', ['mcp']);
    return next();
  }

  return c.json({ error: 'Invalid MCP token' }, 403);
}

/**
 * Elevated-scope gate for /api/triage/* and the MCP triage_* tools.
 *
 * The triage queue lists, claims, and completes orchestration intents that may
 * be `privileged` or `legalink` — exposing them to any ordinary ChittyAuth
 * user token (which authMiddleware grants `['admin']` for KV tokens or the
 * raw `scopes` claim for ChittyAuth tokens) is too broad. This middleware
 * runs AFTER authMiddleware/mcpAuthMiddleware has populated `c.var.scopes`
 * and enforces that the caller carries one of the recognized elevated
 * scopes:
 *   - `chittytriage:write`  — canonical scope name for triage mutation
 *   - `chittytriage:admin`  — admin-level
 *   - `admin`               — local KV-token superuser path (authMiddleware
 *                              sets ['admin'] for KV-issued tokens)
 *   - `*`                   — wildcard (operator/service principal)
 *
 * fixes codex-p2 PR#104 P1 — elevated scope on triage routes/tools.
 */
export async function requireTriageScope(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next,
) {
  const scopes = c.get('scopes') || [];
  const ok = scopes.some(
    (s) => s === 'chittytriage:write' || s === 'chittytriage:admin' || s === 'admin' || s === '*',
  );
  if (!ok) {
    return c.json({ error: 'Insufficient scope: chittytriage:write required' }, 403);
  }
  return next();
}

/**
 * Returns true if the caller has the elevated triage scope. Used by MCP
 * tool handlers and `tools/list` filtering, which run inside a JSON-RPC
 * dispatcher rather than as Hono middleware.
 *
 * fixes codex-p2 PR#104 P1 — scope-aware MCP triage tool advertisement.
 */
export function hasTriageScope(scopes: string[] | undefined | null): boolean {
  if (!scopes) return false;
  return scopes.some(
    (s) => s === 'chittytriage:write' || s === 'chittytriage:admin' || s === 'admin' || s === '*',
  );
}
