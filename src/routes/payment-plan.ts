import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { generatePaymentPlan, savePaymentPlan, simulateScenario } from '../lib/payment-planner';
import { paymentPlanGenerateSchema, paymentPlanSimulateSchema } from '../lib/validators';

export const paymentPlanRoutes = new Hono<{ Bindings: Env }>();

// GET /api/payment-plan — current active plan
paymentPlanRoutes.get('/', async (c) => {
  const sql = getDb(c.env);

  const [plan] = await sql`
    SELECT * FROM cc_payment_plans
    WHERE status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!plan) {
    // Also return latest draft if no active plan
    const [draft] = await sql`
      SELECT * FROM cc_payment_plans
      WHERE status = 'draft'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return c.json(draft || null);
  }

  return c.json(plan);
});

// POST /api/payment-plan/generate — generate a new plan
paymentPlanRoutes.post('/generate', async (c) => {
  const raw = await c.req.json();
  const parsed = paymentPlanGenerateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const plan = await generatePaymentPlan(sql, parsed.data);
  const planId = await savePaymentPlan(sql, plan);

  return c.json({ id: planId, ...plan });
});

// POST /api/payment-plan/simulate — run a scenario with overrides
paymentPlanRoutes.post('/simulate', async (c) => {
  const raw = await c.req.json();
  const parsed = paymentPlanSimulateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const sql = getDb(c.env);
  const result = await simulateScenario(sql, parsed.data);

  return c.json(result);
});

// GET /api/payment-plan/:id/schedule — detailed schedule for a plan
paymentPlanRoutes.get('/:id/schedule', async (c) => {
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const [plan] = await sql`
    SELECT schedule, warnings, plan_type, starting_balance, ending_balance,
           lowest_balance, lowest_balance_date, total_inflows, total_outflows,
           total_late_fees_avoided, total_late_fees_risked
    FROM cc_payment_plans WHERE id = ${id}::uuid
  `;

  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  return c.json(plan);
});

// POST /api/payment-plan/:id/activate — set a plan as the active plan
paymentPlanRoutes.post('/:id/activate', async (c) => {
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // Deactivate any currently active plan
  await sql`UPDATE cc_payment_plans SET status = 'abandoned' WHERE status = 'active'`;

  // Activate the requested plan
  const [plan] = await sql`
    UPDATE cc_payment_plans SET status = 'active'
    WHERE id = ${id}::uuid RETURNING *
  `;

  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  return c.json(plan);
});
