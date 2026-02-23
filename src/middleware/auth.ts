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
 * MCP auth middleware for /mcp/* routes.
 * Verifies a shared service token stored in KV.
 */
export async function mcpAuthMiddleware(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  // Dev mode bypass
  if (c.env.ENVIRONMENT !== 'production') {
    c.set('userId', 'mcp-client');
    c.set('scopes', ['mcp']);
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'MCP authentication required' }, 401);
  }

  const token = authHeader.slice(7);
  const validToken = await c.env.COMMAND_KV.get('mcp:service_token');

  if (!validToken || token !== validToken) {
    return c.json({ error: 'Invalid MCP token' }, 403);
  }

  c.set('userId', 'mcp-client');
  c.set('scopes', ['mcp']);
  return next();
}
