import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { computeVendorRisk, vendorRiskInputFromRow, numOrNull, AT_RISK_THRESHOLD } from '../lib/vendor-risk';
import { createVendorSchema, updateVendorSchema, vendorQuerySchema } from '../lib/validators';

export const vendorRoutes = new Hono<{ Bindings: Env }>();

const round2 = (n: number) => Math.round(n * 100) / 100;

// List vendors with filtering + live spend-risk
vendorRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const qResult = vendorQuerySchema.safeParse({
    category: c.req.query('category'),
    status: c.req.query('status'),
    at_risk: c.req.query('at_risk'),
  });
  if (!qResult.success) return c.json({ error: 'Invalid query params', issues: qResult.error.issues }, 400);
  const category = qResult.data.category || null;
  const status = qResult.data.status || null;
  const atRisk = qResult.data.at_risk === 'true';

  const rows = await sql`
    SELECT * FROM cc_vendors
    WHERE (${category}::text IS NULL OR category = ${category})
      AND (${status}::text IS NULL OR status = ${status})
    ORDER BY risk_score DESC NULLS LAST, next_bill_date ASC NULLS LAST, vendor_name ASC
  `;
  const vendors = rows
    .map((r) => ({ ...r, risk: computeVendorRisk(vendorRiskInputFromRow(r)) }))
    // Sort by *live* risk, not the stored (possibly stale) risk_score column.
    .sort((a, b) => b.risk.score - a.risk.score);
  const filtered = atRisk ? vendors.filter((v) => v.risk.score >= AT_RISK_THRESHOLD) : vendors;
  return c.json({ count: filtered.length, vendors: filtered });
});

// Spend-control rollup: MTD by category, at-risk vendors, upcoming bills, zombies.
// Registered before '/:id' so 'summary' isn't captured as an id.
vendorRoutes.get('/summary', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT * FROM cc_vendors WHERE status != 'cancelled'`;

  let totalMtd = 0;
  let monthlyCommitted = 0;
  const byLevel: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategoryMap = new Map<string, { category: string; vendor_count: number; mtd_spend: number; monthly_committed: number }>();
  const atRisk: Array<Record<string, unknown>> = [];
  const zombies: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const mtd = numOrNull(r.mtd_spend) ?? 0;
    const expected = numOrNull(r.expected_amount) ?? 0;
    const cycle = (r.billing_cycle as string | null) ?? null;
    const cat = (r.category as string) || 'other';

    totalMtd += mtd;
    if (cycle === 'monthly') monthlyCommitted += expected;

    const agg = byCategoryMap.get(cat) || { category: cat, vendor_count: 0, mtd_spend: 0, monthly_committed: 0 };
    agg.vendor_count += 1;
    agg.mtd_spend += mtd;
    if (cycle === 'monthly') agg.monthly_committed += expected;
    byCategoryMap.set(cat, agg);

    const risk = computeVendorRisk(vendorRiskInputFromRow(r));
    byLevel[risk.level] = (byLevel[risk.level] || 0) + 1;
    if (risk.score >= AT_RISK_THRESHOLD) {
      atRisk.push({ id: r.id, vendor_name: r.vendor_name, category: cat, payment_status: r.payment_status, score: risk.score, level: risk.level, reasons: risk.reasons });
    }
    if (r.status === 'zombie') {
      zombies.push({ id: r.id, vendor_name: r.vendor_name, expected_amount: expected, billing_cycle: cycle });
    }
  }

  const upcomingBills = await sql`
    SELECT id, vendor_name, category, next_bill_date, expected_amount, auto_pay, payment_status
    FROM cc_vendors
    WHERE status != 'cancelled' AND next_bill_date IS NOT NULL
      AND next_bill_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    ORDER BY next_bill_date ASC
  `;

  atRisk.sort((a, b) => (b.score as number) - (a.score as number));
  const byCategory = [...byCategoryMap.values()]
    .map((a) => ({ ...a, mtd_spend: round2(a.mtd_spend), monthly_committed: round2(a.monthly_committed) }))
    .sort((a, b) => b.mtd_spend - a.mtd_spend);

  return c.json({
    vendor_count: rows.length,
    total_mtd_spend: round2(totalMtd),
    monthly_committed: round2(monthlyCommitted),
    by_level: byLevel,
    by_category: byCategory,
    at_risk: atRisk,
    upcoming_bills: upcomingBills,
    zombies,
  });
});

// Single vendor with live spend-risk
vendorRoutes.get('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const [row] = await sql`SELECT * FROM cc_vendors WHERE id = ${id}`;
  if (!row) return c.json({ error: 'Vendor not found' }, 404);
  return c.json({ ...row, risk: computeVendorRisk(vendorRiskInputFromRow(row)) });
});

// Create or upsert a vendor (keyed on vendor_name). POST is a FULL representation:
// on conflict every column is overwritten from this payload, and omitted fields
// fall back to their defaults (e.g. mtd_spend→0, payment_status→'unknown'). Use
// PATCH for partial updates so existing spend/status data isn't clobbered.
vendorRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createVendorSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;

  const riskScore = computeVendorRisk({
    payment_status: body.payment_status || 'unknown',
    auto_pay: body.auto_pay || false,
    next_bill_date: body.next_bill_date || null,
    mtd_spend: body.mtd_spend ?? null,
    budget_limit: body.budget_limit ?? null,
    spending_limit: body.spending_limit ?? null,
    status: body.status || 'active',
  }).score;

  const sql = getDb(c.env);
  const [vendor] = await sql`
    INSERT INTO cc_vendors (vendor_name, category, billing_cycle, expected_amount, currency, next_bill_date, auto_pay, payment_status, payment_method, spending_limit, mtd_spend, budget_limit, status, owner, account_id, risk_score, metadata)
    VALUES (${body.vendor_name}, ${body.category || 'other'}, ${body.billing_cycle || null}, ${body.expected_amount ?? null}, ${body.currency || 'USD'}, ${body.next_bill_date || null}, ${body.auto_pay || false}, ${body.payment_status || 'unknown'}, ${body.payment_method || null}, ${body.spending_limit ?? null}, ${body.mtd_spend ?? 0}, ${body.budget_limit ?? null}, ${body.status || 'active'}, ${body.owner || null}, ${body.account_id || null}, ${riskScore}, ${JSON.stringify(body.metadata || {})})
    ON CONFLICT (vendor_name) DO UPDATE SET
      category = EXCLUDED.category,
      billing_cycle = EXCLUDED.billing_cycle,
      expected_amount = EXCLUDED.expected_amount,
      currency = EXCLUDED.currency,
      next_bill_date = EXCLUDED.next_bill_date,
      auto_pay = EXCLUDED.auto_pay,
      payment_status = EXCLUDED.payment_status,
      payment_method = EXCLUDED.payment_method,
      spending_limit = EXCLUDED.spending_limit,
      mtd_spend = EXCLUDED.mtd_spend,
      budget_limit = EXCLUDED.budget_limit,
      status = EXCLUDED.status,
      owner = EXCLUDED.owner,
      account_id = EXCLUDED.account_id,
      metadata = EXCLUDED.metadata,
      risk_score = EXCLUDED.risk_score,
      updated_at = NOW()
    RETURNING *
  `;
  return c.json(vendor, 201);
});

// Partial update; recomputes risk from the merged row
vendorRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = updateVendorSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);

  const [existing] = await sql`SELECT * FROM cc_vendors WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Vendor not found' }, 404);

  const riskScore = computeVendorRisk(vendorRiskInputFromRow({
    payment_status: body.payment_status ?? existing.payment_status,
    auto_pay: body.auto_pay ?? existing.auto_pay,
    next_bill_date: body.next_bill_date ?? existing.next_bill_date,
    mtd_spend: body.mtd_spend ?? existing.mtd_spend,
    budget_limit: body.budget_limit ?? existing.budget_limit,
    spending_limit: body.spending_limit ?? existing.spending_limit,
    status: body.status ?? existing.status,
  })).score;

  const [vendor] = await sql`
    UPDATE cc_vendors SET
      category = COALESCE(${body.category ?? null}, category),
      billing_cycle = COALESCE(${body.billing_cycle ?? null}, billing_cycle),
      expected_amount = COALESCE(${body.expected_amount ?? null}, expected_amount),
      currency = COALESCE(${body.currency ?? null}, currency),
      next_bill_date = COALESCE(${body.next_bill_date ?? null}, next_bill_date),
      auto_pay = COALESCE(${body.auto_pay ?? null}, auto_pay),
      payment_status = COALESCE(${body.payment_status ?? null}, payment_status),
      payment_method = COALESCE(${body.payment_method ?? null}, payment_method),
      spending_limit = COALESCE(${body.spending_limit ?? null}, spending_limit),
      mtd_spend = COALESCE(${body.mtd_spend ?? null}, mtd_spend),
      budget_limit = COALESCE(${body.budget_limit ?? null}, budget_limit),
      status = COALESCE(${body.status ?? null}, status),
      owner = COALESCE(${body.owner ?? null}, owner),
      account_id = COALESCE(${body.account_id ?? null}, account_id),
      metadata = COALESCE(${body.metadata !== undefined ? JSON.stringify(body.metadata) : null}::jsonb, metadata),
      risk_score = ${riskScore},
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return c.json(vendor);
});

// Recompute risk for all non-cancelled vendors (batched to avoid N+1)
vendorRoutes.post('/recompute-risk', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT * FROM cc_vendors WHERE status != 'cancelled'`;
  const updates = rows.map((r) => ({ id: r.id as string, score: computeVendorRisk(vendorRiskInputFromRow(r)).score }));

  if (updates.length > 0) {
    const ids = updates.map((u) => u.id);
    const scores = updates.map((u) => u.score);
    await sql`
      UPDATE cc_vendors SET risk_score = bulk.score, updated_at = NOW()
      FROM (SELECT unnest(${ids}::uuid[]) AS id, unnest(${scores}::int[]) AS score) AS bulk
      WHERE cc_vendors.id = bulk.id
    `;
  }
  return c.json({ updated: updates.length, message: `Recomputed risk for ${updates.length} vendors` });
});
