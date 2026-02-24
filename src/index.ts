import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, bridgeAuthMiddleware, mcpAuthMiddleware } from './middleware/auth';
import type { AuthVariables } from './middleware/auth';
import { getDb } from './lib/db';
import { runCronSync } from './lib/cron';
import { dashboardRoutes } from './routes/dashboard';
import { accountRoutes } from './routes/accounts';
import { obligationRoutes } from './routes/obligations';
import { disputeRoutes } from './routes/disputes';
import { legalRoutes } from './routes/legal';
import { documentRoutes } from './routes/documents';
import { recommendationRoutes } from './routes/recommendations';
import { syncRoutes } from './routes/sync';
import { cashflowRoutes } from './routes/cashflow';
import { bridgeRoutes } from './routes/bridge';
import { mcpRoutes } from './routes/mcp';
import { authRoutes } from './routes/auth';

export type Env = {
  HYPERDRIVE: Hyperdrive;
  DOCUMENTS: R2Bucket;
  COMMAND_KV: KVNamespace;
  DATABASE_URL?: string;
  ENVIRONMENT?: string;
  CHITTYAUTH_URL?: string;
  CHITTYLEDGER_URL?: string;
  CHITTYFINANCE_URL?: string;
  CHITTYCHARGE_URL?: string;
  CHITTYCONNECT_URL?: string;
  CHITTYBOOKS_URL?: string;
  CHITTYASSETS_URL?: string;
  CHITTYSCRAPE_URL?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
};

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// CORS for frontend
app.use('*', cors({
  origin: ['https://app.command.chitty.cc', 'https://command.mychitty.com', 'https://chittycommand-ui.pages.dev', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Global error handler — never leak internal details
app.onError((err, c) => {
  console.error(`[${c.req.method}] ${c.req.path}:`, err.message);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// 404 handler — do not leak request URL
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Health endpoint (unauthenticated)
app.get('/health', (c) => c.json({
  status: 'ok',
  service: 'chittycommand',
  version: '0.1.0',
  timestamp: new Date().toISOString(),
}));

// Service status (unauthenticated) — ChittyOS standard
app.get('/api/v1/status', (c) => c.json({
  name: 'ChittyCommand',
  version: '0.1.0',
  environment: c.env.ENVIRONMENT || 'production',
  canonicalUri: 'chittycanon://core/services/chittycommand',
  tier: 5,
}));

// Auth routes — unauthenticated (handles login/verify itself)
app.route('/auth', authRoutes);

// Bridge routes — service token or user token (mounted before global /api/* auth)
app.use('/api/bridge/*', bridgeAuthMiddleware);
app.route('/api/bridge', bridgeRoutes);

// Authenticate all other /api/* routes via ChittyAuth
app.use('/api/*', authMiddleware);

// API routes
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/accounts', accountRoutes);
app.route('/api/obligations', obligationRoutes);
app.route('/api/disputes', disputeRoutes);
app.route('/api/legal', legalRoutes);
app.route('/api/documents', documentRoutes);
app.route('/api/recommendations', recommendationRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/cashflow', cashflowRoutes);

// MCP server — authenticated via shared token in KV
app.use('/mcp/*', mcpAuthMiddleware);
app.route('/mcp', mcpRoutes);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const sql = getDb(env);
    ctx.waitUntil(runCronSync(event, env, sql));
  },
};
