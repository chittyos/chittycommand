import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { actOnRecommendationSchema } from '../lib/validators';
import { runTriage } from '../lib/triage';

export const recommendationRoutes = new Hono<{ Bindings: Env }>();

recommendationRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') || 'active';
  const recs = await sql`
    SELECT r.*, o.payee as obligation_payee, o.amount_due, o.due_date,
           d.title as dispute_title, d.counterparty
    FROM cc_recommendations r
    LEFT JOIN cc_obligations o ON r.obligation_id = o.id
    LEFT JOIN cc_disputes d ON r.dispute_id = d.id
    WHERE r.status = ${status}
    ORDER BY r.priority ASC
  `;
  return c.json(recs);
});

// Act on a recommendation
recommendationRoutes.post('/:id/act', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = actOnRecommendationSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);

  const [rec] = await sql`
    UPDATE cc_recommendations SET status = 'completed', acted_on_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!rec) return c.json({ error: 'Recommendation not found' }, 404);

  // Log the action
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, request_payload, status)
    VALUES ('recommendation_acted', 'recommendation', ${id}, ${body.action_taken || 'Acted on recommendation'}, ${JSON.stringify(body)}, 'completed')
  `;

  return c.json(rec);
});

// Generate recommendations via triage engine
recommendationRoutes.post('/generate', async (c) => {
  const sql = getDb(c.env);
  const result = await runTriage(sql);
  return c.json(result);
});

// Dismiss a recommendation
recommendationRoutes.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const [rec] = await sql`
    UPDATE cc_recommendations SET status = 'dismissed', acted_on_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!rec) return c.json({ error: 'Recommendation not found' }, 404);
  return c.json(rec);
});
