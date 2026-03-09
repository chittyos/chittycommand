import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { createLegalDeadlineSchema, updateLegalDeadlineSchema } from '../lib/validators';

export const legalRoutes = new Hono<{ Bindings: Env }>();

legalRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const deadlines = await sql`
    SELECT
      l.*,
      d.id AS dispute_id,
      d.title AS dispute_title
    FROM cc_legal_deadlines l
    LEFT JOIN LATERAL (
      SELECT id, title, status, priority, created_at
      FROM cc_disputes d
      WHERE l.case_ref = COALESCE(d.metadata->>'ledger_case_id', d.metadata->>'case_ref')
      ORDER BY
        CASE WHEN d.status = 'open' THEN 0 ELSE 1 END,
        d.priority ASC NULLS LAST,
        d.created_at DESC
      LIMIT 1
    ) d ON TRUE
    WHERE l.status != 'completed'
    ORDER BY deadline_date ASC
  `;
  return c.json(deadlines);
});

legalRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createLegalDeadlineSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);
  const [deadline] = await sql`
    INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, status, urgency_score, evidence_db_ref, metadata)
    VALUES (${body.case_ref}, ${body.case_system || null}, ${body.deadline_type}, ${body.title}, ${body.description || null}, ${body.deadline_date}, ${body.status || 'upcoming'}, ${body.urgency_score || null}, ${body.evidence_db_ref || null}, ${JSON.stringify(body.metadata || {})})
    RETURNING *
  `;
  return c.json(deadline, 201);
});

legalRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = updateLegalDeadlineSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);
  const [deadline] = await sql`
    UPDATE cc_legal_deadlines SET
      status = COALESCE(${body.status ?? null}, status),
      deadline_date = COALESCE(${body.deadline_date ?? null}, deadline_date),
      urgency_score = COALESCE(${body.urgency_score ?? null}, urgency_score),
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!deadline) return c.json({ error: 'Deadline not found' }, 404);
  return c.json(deadline);
});
