import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { generateProjections } from '../lib/projections';
import { cashflowScenarioSchema } from '../lib/validators';

export const cashflowRoutes = new Hono<{ Bindings: Env }>();

// Get cached projections
cashflowRoutes.get('/projections', async (c) => {
  const sql = getDb(c.env);
  const projections = await sql`
    SELECT projection_date, projected_inflow, projected_outflow, projected_balance, obligations, confidence
    FROM cc_cashflow_projections
    WHERE generated_at >= NOW() - INTERVAL '2 days'
    ORDER BY projection_date ASC
  `;
  return c.json(projections);
});

// Regenerate projections on demand
cashflowRoutes.post('/generate', async (c) => {
  const sql = getDb(c.env);
  const result = await generateProjections(sql);
  return c.json(result);
});

// Scenario: "what if I defer obligation X?"
cashflowRoutes.post('/scenario', async (c) => {
  const parsed = cashflowScenarioSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const { defer_obligation_ids } = parsed.data;

  const sql = getDb(c.env);

  // Get current cash
  const [balanceRow] = await sql`
    SELECT COALESCE(SUM(current_balance), 0) as total
    FROM cc_accounts WHERE account_type IN ('checking', 'savings')
  `;
  const startingBalance = parseFloat(balanceRow?.total || '0');

  // Get all obligations excluding deferred ones
  const obligations = await sql`
    SELECT payee, amount_due, amount_minimum, due_date
    FROM cc_obligations
    WHERE status IN ('pending', 'overdue')
    AND id != ALL(${defer_obligation_ids}::uuid[])
    AND due_date <= CURRENT_DATE + INTERVAL '30 days'
    ORDER BY due_date ASC
  `;

  const deferred = await sql`
    SELECT payee, amount_due, due_date
    FROM cc_obligations WHERE id = ANY(${defer_obligation_ids}::uuid[])
  `;

  const totalDue = obligations.reduce((sum: number, o: any) => sum + parseFloat(o.amount_due || o.amount_minimum || '0'), 0);
  const totalDeferred = deferred.reduce((sum: number, o: any) => sum + parseFloat(o.amount_due || '0'), 0);

  return c.json({
    starting_balance: startingBalance,
    total_due_without_deferrals: totalDue,
    total_deferred: totalDeferred,
    projected_balance: Math.round((startingBalance - totalDue) * 100) / 100,
    original_balance: Math.round((startingBalance - totalDue - totalDeferred) * 100) / 100,
    savings_from_deferral: Math.round(totalDeferred * 100) / 100,
    deferred_items: deferred.map((d: any) => ({ payee: d.payee, amount: d.amount_due, due_date: d.due_date })),
  });
});
