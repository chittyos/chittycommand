import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { discoverRevenueSources } from '../lib/revenue';
import { createRevenueSourceSchema, updateRevenueSourceSchema } from '../lib/validators';

export const revenueRoutes = new Hono<{ Bindings: Env }>();

// GET /api/revenue — list all revenue sources
revenueRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') || 'active';

  const sources = await sql`
    SELECT rs.*, a.account_name, a.institution
    FROM cc_revenue_sources rs
    LEFT JOIN cc_accounts a ON rs.account_id = a.id
    WHERE rs.status = ${status}
    ORDER BY rs.amount DESC
  `;

  // Also compute total monthly expected
  const [totals] = await sql`
    SELECT
      COUNT(*)::int AS count,
      COALESCE(SUM(amount), 0)::numeric AS total_monthly,
      COALESCE(SUM(amount * confidence), 0)::numeric AS weighted_monthly
    FROM cc_revenue_sources
    WHERE status = 'active' AND recurrence = 'monthly'
  `;

  return c.json({
    sources,
    summary: {
      count: (totals as Record<string, number>).count || 0,
      total_monthly: parseFloat(String((totals as Record<string, unknown>).total_monthly || '0')),
      weighted_monthly: parseFloat(String((totals as Record<string, unknown>).weighted_monthly || '0')),
    },
  });
});

// POST /api/revenue/discover — discover revenue sources from transaction history
revenueRoutes.post('/discover', async (c) => {
  const sql = getDb(c.env);
  try {
    const result = await discoverRevenueSources(sql);
    return c.json(result);
  } catch (e: unknown) {
    console.error('[revenue:discover] failed:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Discovery failed' }, 500);
  }
});

// POST /api/revenue — manually add a revenue source
revenueRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = createRevenueSourceSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const data = parsed.data;

  const [source] = await sql`
    INSERT INTO cc_revenue_sources (
      source, source_id, description, amount, recurrence, recurrence_day,
      next_expected_date, confidence, verified_by, contract_ref, account_id
    ) VALUES (
      ${data.source}, ${data.source_id || null}, ${data.description},
      ${data.amount}, ${data.recurrence || null}, ${data.recurrence_day || null},
      ${data.next_expected_date || null}, ${data.confidence || 0.50},
      ${data.verified_by || 'manual'}, ${data.contract_ref || null},
      ${data.account_id || null}
    ) RETURNING *
  `;

  return c.json(source, 201);
});

// PUT /api/revenue/:id — update a revenue source
revenueRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = updateRevenueSourceSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const data = parsed.data;

  // Build dynamic update — only set provided fields
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (data.amount !== undefined) { sets.push('amount'); vals.push(data.amount); }
  if (data.recurrence !== undefined) { sets.push('recurrence'); vals.push(data.recurrence); }
  if (data.confidence !== undefined) { sets.push('confidence'); vals.push(data.confidence); }
  if (data.status !== undefined) { sets.push('status'); vals.push(data.status); }
  if (data.next_expected_date !== undefined) { sets.push('next_expected_date'); vals.push(data.next_expected_date); }
  if (data.contract_ref !== undefined) { sets.push('contract_ref'); vals.push(data.contract_ref); }

  // Use a simple approach: update all fields
  const [updated] = await sql`
    UPDATE cc_revenue_sources SET
      amount = COALESCE(${data.amount ?? null}, amount),
      recurrence = COALESCE(${data.recurrence ?? null}, recurrence),
      confidence = COALESCE(${data.confidence ?? null}, confidence),
      status = COALESCE(${data.status ?? null}, status),
      next_expected_date = COALESCE(${data.next_expected_date ?? null}, next_expected_date),
      contract_ref = COALESCE(${data.contract_ref ?? null}, contract_ref),
      updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;

  if (!updated) return c.json({ error: 'Revenue source not found' }, 404);
  return c.json(updated);
});
