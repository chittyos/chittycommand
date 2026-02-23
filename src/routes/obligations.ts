import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { computeUrgencyScore } from '../lib/urgency';
import { chargeClient } from '../lib/integrations';
import { createObligationSchema, updateObligationSchema } from '../lib/validators';

export const obligationRoutes = new Hono<{ Bindings: Env }>();

// List obligations with filtering
obligationRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const category = c.req.query('category');

  let obligations;
  if (status && category) {
    obligations = await sql`SELECT * FROM cc_obligations WHERE status = ${status} AND category = ${category} ORDER BY urgency_score DESC NULLS LAST, due_date ASC`;
  } else if (status) {
    obligations = await sql`SELECT * FROM cc_obligations WHERE status = ${status} ORDER BY urgency_score DESC NULLS LAST, due_date ASC`;
  } else if (category) {
    obligations = await sql`SELECT * FROM cc_obligations WHERE category = ${category} ORDER BY urgency_score DESC NULLS LAST, due_date ASC`;
  } else {
    obligations = await sql`SELECT * FROM cc_obligations ORDER BY urgency_score DESC NULLS LAST, due_date ASC`;
  }
  return c.json(obligations);
});

// Calendar view: obligations grouped by due date
obligationRoutes.get('/calendar', async (c) => {
  const sql = getDb(c.env);
  const start = c.req.query('start') || new Date().toISOString().slice(0, 10);
  const end = c.req.query('end') || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const obligations = await sql`
    SELECT id, payee, category, amount_due, due_date, status, urgency_score, auto_pay
    FROM cc_obligations
    WHERE due_date BETWEEN ${start} AND ${end}
    ORDER BY due_date ASC
  `;
  return c.json(obligations);
});

// Create obligation
obligationRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createObligationSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const urgencyScore = computeUrgencyScore({
    due_date: body.due_date,
    category: body.category,
    status: body.status || 'pending',
    auto_pay: body.auto_pay || false,
    late_fee: body.late_fee || null,
    grace_period_days: body.grace_period_days || 0,
  });

  const sql = getDb(c.env);
  const [obligation] = await sql`
    INSERT INTO cc_obligations (account_id, category, subcategory, payee, amount_due, amount_minimum, due_date, recurrence, recurrence_day, status, auto_pay, negotiable, late_fee, grace_period_days, urgency_score, action_type, action_payload, metadata)
    VALUES (${body.account_id || null}, ${body.category}, ${body.subcategory || null}, ${body.payee}, ${body.amount_due || null}, ${body.amount_minimum || null}, ${body.due_date}, ${body.recurrence || null}, ${body.recurrence_day || null}, ${body.status || 'pending'}, ${body.auto_pay || false}, ${body.negotiable || false}, ${body.late_fee || null}, ${body.grace_period_days || 0}, ${urgencyScore}, ${body.action_type || null}, ${body.action_payload ? JSON.stringify(body.action_payload) : null}, ${JSON.stringify(body.metadata || {})})
    RETURNING *
  `;
  return c.json(obligation, 201);
});

// Update obligation
obligationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = updateObligationSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);

  const [existing] = await sql`SELECT * FROM cc_obligations WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Obligation not found' }, 404);

  // Recompute urgency if relevant fields changed
  const urgencyScore = computeUrgencyScore({
    due_date: body.due_date || existing.due_date,
    category: existing.category,
    status: body.status || existing.status,
    auto_pay: body.auto_pay ?? existing.auto_pay,
    late_fee: existing.late_fee ? parseFloat(existing.late_fee) : null,
    grace_period_days: existing.grace_period_days || 0,
  });

  const [obligation] = await sql`
    UPDATE cc_obligations SET
      amount_due = COALESCE(${body.amount_due ?? null}, amount_due),
      amount_minimum = COALESCE(${body.amount_minimum ?? null}, amount_minimum),
      due_date = COALESCE(${body.due_date ?? null}, due_date),
      status = COALESCE(${body.status ?? null}, status),
      auto_pay = COALESCE(${body.auto_pay ?? null}, auto_pay),
      urgency_score = ${urgencyScore},
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return c.json(obligation);
});

// Mark as paid (optionally execute payment via ChittyCharge)
obligationRoutes.post('/:id/pay', async (c) => {
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const [obligation] = await sql`SELECT * FROM cc_obligations WHERE id = ${id}`;
  if (!obligation) return c.json({ error: 'Obligation not found' }, 404);

  let chargeId: string | undefined;

  // If action_type is 'charge' and amount is set, execute via ChittyCharge
  const charge = chargeClient(c.env);
  if (charge && obligation.action_type === 'charge' && obligation.amount_due) {
    const result = await charge.createHold({
      amount: parseFloat(obligation.amount_due),
      description: `Payment: ${obligation.payee}`,
      metadata: { obligation_id: id, payee: obligation.payee as string },
    });
    if (result?.id) {
      chargeId = result.id;
      // Auto-capture the hold
      await charge.captureHold(result.id);
    }
  }

  const [updated] = await sql`
    UPDATE cc_obligations SET status = 'paid', urgency_score = 0, updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;

  // Log the action
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
    VALUES ('mark_paid', 'obligation', ${id}, ${'Paid ' + obligation.payee + (chargeId ? ' via ChittyCharge' : ' (manual)')}, 'completed', ${chargeId ? JSON.stringify({ charge_id: chargeId }) : '{}'})
  `;
  return c.json({ ...updated, charge_id: chargeId });
});

// Recalculate all urgency scores (batched to avoid N+1)
obligationRoutes.post('/recalculate-urgency', async (c) => {
  const sql = getDb(c.env);
  const obligations = await sql`SELECT * FROM cc_obligations WHERE status IN ('pending', 'overdue')`;

  const updates: { id: string; score: number; status: string }[] = [];
  for (const ob of obligations) {
    const score = computeUrgencyScore({
      due_date: ob.due_date,
      category: ob.category,
      status: ob.status,
      auto_pay: ob.auto_pay,
      late_fee: ob.late_fee ? parseFloat(ob.late_fee) : null,
      grace_period_days: ob.grace_period_days || 0,
    });
    const dueDate = new Date(ob.due_date);
    const newStatus = dueDate < new Date() && ob.status === 'pending' ? 'overdue' : ob.status;
    updates.push({ id: ob.id, score, status: newStatus });
  }

  if (updates.length > 0) {
    const ids = updates.map(u => u.id);
    const scores = updates.map(u => u.score);
    const statuses = updates.map(u => u.status);
    await sql`
      UPDATE cc_obligations SET
        urgency_score = bulk.score,
        status = bulk.status,
        updated_at = NOW()
      FROM (SELECT unnest(${ids}::uuid[]) AS id, unnest(${scores}::int[]) AS score, unnest(${statuses}::text[]) AS status) AS bulk
      WHERE cc_obligations.id = bulk.id
    `;
  }

  return c.json({ updated: updates.length, message: `Recalculated urgency for ${updates.length} obligations` });
});
