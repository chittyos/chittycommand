/**
 * Hermetic regression tests for the vendor MCP tools (query_vendors,
 * get_vendor_risk). getDb is mocked (same approach as tests/mcp.test.ts) so
 * these run without a database and pin the exact bug Codex flagged on #119:
 * at_risk filtering + risk recompute must happen BEFORE limiting, and ordering
 * must use live risk — not the stored (possibly stale) risk_score column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/index';
import { mcpAuthMiddleware } from '../src/middleware/auth';
import type { AuthVariables } from '../src/middleware/auth';

// Mutable row set the mocked sql tagged-template resolves to. Hoisted so the
// vi.mock factory can close over it.
const dbState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('../src/lib/db', () => ({
  // getDb returns an sql() tagged-template that ignores the query and resolves
  // the current dbState.rows — each vendor tool issues a single SELECT.
  getDb: () => async () => dbState.rows,
  typedRows: <T>(rows: readonly Record<string, unknown>[]): T[] => rows as unknown as T[],
}));

import { mcpRoutes } from '../src/routes/mcp';

function makeEnv(): Pick<Env, 'ENVIRONMENT' | 'COMMAND_KV'> & Partial<Env> {
  return {
    ENVIRONMENT: 'test',
    COMMAND_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('/mcp/*', mcpAuthMiddleware);
  app.route('/mcp', mcpRoutes);
  const env = makeEnv();
  return async function callTool(name: string, args: Record<string, unknown> = {}) {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const res = await app.fetch(req, env as unknown as Env);
    const json = (await res.json()) as Record<string, unknown>;
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
  };
}

// A vendor row as Neon returns it (snake_case, NUMERIC as strings).
function row(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: over.id ?? `id-${over.vendor_name}`,
    vendor_name: over.vendor_name,
    category: over.category ?? 'other',
    billing_cycle: over.billing_cycle ?? 'monthly',
    expected_amount: over.expected_amount ?? '10.00',
    currency: 'USD',
    next_bill_date: over.next_bill_date ?? null,
    auto_pay: over.auto_pay ?? false,
    payment_status: over.payment_status ?? 'active',
    payment_method: null,
    spending_limit: over.spending_limit ?? null,
    mtd_spend: over.mtd_spend ?? null,
    budget_limit: over.budget_limit ?? null,
    status: over.status ?? 'active',
    risk_score: over.risk_score ?? null, // deliberately stale/null to prove live recompute
  };
}

// Fixture: 5 active vendors. Healthy/low first, high-risk LAST in array order,
// every stored risk_score null — so any reliance on stored order/score breaks.
const FIXTURE = [
  row({ vendor_name: 'healthy', payment_status: 'active', auto_pay: true, mtd_spend: '10', spending_limit: '100' }), // 0 (low)
  row({ vendor_name: 'unknown-low', payment_status: 'unknown' }), // 5 (low)
  row({ vendor_name: 'limited', payment_status: 'limited' }), // 35 (medium)
  row({ vendor_name: 'failed-hi', payment_status: 'failed', mtd_spend: '200', spending_limit: '100' }), // 75 (critical)
  row({ vendor_name: 'failed-50', payment_status: 'failed', mtd_spend: '50', spending_limit: '100' }), // 50 (high)
];

beforeEach(() => {
  dbState.rows = FIXTURE.map((r) => ({ ...r }));
});

describe('query_vendors (MCP)', () => {
  it('at_risk=true keeps high-risk vendors even when a small limit would page them out', async () => {
    const callTool = buildApp();
    // limit=1: the buggy version applied LIMIT in SQL before filtering, which
    // could drop the at-risk vendor entirely. Now: filter → sort → slice.
    const { data } = await callTool('query_vendors', { at_risk: true, limit: 1 });
    expect(data.count).toBe(1);
    // Highest live risk among the two at-risk vendors wins the single slot.
    expect(data.vendors[0].vendor_name).toBe('failed-hi');
    expect(data.vendors[0].risk_score).toBe(75);
  });

  it('at_risk=true returns ALL vendors at/over threshold (not just the first page)', async () => {
    const callTool = buildApp();
    const { data } = await callTool('query_vendors', { at_risk: true });
    expect(data.count).toBe(2);
    expect(data.vendors.map((v: { vendor_name: string }) => v.vendor_name).sort()).toEqual(['failed-50', 'failed-hi']);
  });

  it('orders by LIVE risk, not the stale stored risk_score column', async () => {
    const callTool = buildApp();
    const { data } = await callTool('query_vendors', { limit: 2 });
    expect(data.vendors.map((v: { vendor_name: string }) => v.vendor_name)).toEqual(['failed-hi', 'failed-50']);
  });

  it('recomputes risk live when stored risk_score is null', async () => {
    const callTool = buildApp();
    const { data } = await callTool('query_vendors', {});
    const healthy = data.vendors.find((v: { vendor_name: string }) => v.vendor_name === 'healthy');
    expect(healthy.risk_score).toBe(0);
    expect(healthy.risk_level).toBe('low');
  });
});

describe('get_vendor_risk (MCP)', () => {
  it('aggregates by risk level and lists the at-risk vendors', async () => {
    const callTool = buildApp();
    const { data } = await callTool('get_vendor_risk', {});
    expect(data.vendor_count).toBe(5);
    expect(data.by_level).toEqual({ critical: 1, high: 1, medium: 1, low: 2 });
    expect(data.at_risk).toHaveLength(2);
    expect(data.at_risk[0].vendor_name).toBe('failed-hi'); // sorted desc by score
    // total MTD spend: 10 + 200 + 50 = 260 (others null → 0)
    expect(data.total_mtd_spend).toBe(260);
  });
});
