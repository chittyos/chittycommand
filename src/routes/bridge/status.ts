import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';

export const statusRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Cross-Service Status ─────────────────────────────────────

/** Health check all connected services */
statusRoutes.get('/status', async (c) => {
  const services = [
    { name: 'chittyauth', url: c.env.CHITTYAUTH_URL },
    { name: 'chittyledger', url: c.env.CHITTYLEDGER_URL },
    { name: 'chittyfinance', url: c.env.CHITTYFINANCE_URL },
    { name: 'chittycharge', url: c.env.CHITTYCHARGE_URL },
    { name: 'chittyconnect', url: c.env.CHITTYCONNECT_URL },
    { name: 'plaid', url: c.env.PLAID_CLIENT_ID ? `https://${c.env.PLAID_ENV || 'sandbox'}.plaid.com` : undefined },
    { name: 'chittybooks', url: c.env.CHITTYBOOKS_URL },
    { name: 'chittyassets', url: c.env.CHITTYASSETS_URL },
    { name: 'mercury', url: 'https://api.mercury.com' },
    { name: 'chittyscrape', url: c.env.CHITTYSCRAPE_URL },
  ];

  const results = await Promise.all(
    services.map(async (svc) => {
      if (!svc.url) return { name: svc.name, status: 'not_configured' };
      try {
        const res = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { name: svc.name, status: res.ok ? 'ok' : 'error', code: res.status, ...data };
      } catch (err) {
        return { name: svc.name, status: 'unreachable', error: String(err) };
      }
    })
  );

  const healthy = results.filter((r) => r.status === 'ok').length;
  return c.json({ services: results, healthy, total: services.length });
});
