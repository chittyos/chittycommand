import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { ledgerClient } from '../lib/integrations';
import { createDisputeSchema, updateDisputeSchema, createCorrespondenceSchema, disputeQuerySchema } from '../lib/validators';

export const disputeRoutes = new Hono<{ Bindings: Env }>();

// List disputes
disputeRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const qResult = disputeQuerySchema.safeParse({ status: c.req.query('status') });
  if (!qResult.success) return c.json({ error: 'Invalid query params', issues: qResult.error.issues }, 400);
  const status = qResult.data.status || 'open';
  const disputes = await sql`
    SELECT * FROM cc_disputes WHERE status = ${status} ORDER BY priority ASC, created_at DESC
  `;
  return c.json(disputes);
});

// Get dispute with correspondence
disputeRoutes.get('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const [dispute] = await sql`SELECT * FROM cc_disputes WHERE id = ${id}`;
  if (!dispute) return c.json({ error: 'Dispute not found' }, 404);

  const correspondence = await sql`
    SELECT * FROM cc_dispute_correspondence WHERE dispute_id = ${id} ORDER BY sent_at DESC
  `;
  const documents = await sql`
    SELECT * FROM cc_documents WHERE linked_dispute_id = ${id} ORDER BY created_at DESC
  `;
  return c.json({ ...dispute, correspondence, documents });
});

// Create dispute
disputeRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createDisputeSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);
  const [dispute] = await sql`
    INSERT INTO cc_disputes (title, counterparty, dispute_type, amount_claimed, amount_at_stake, status, priority, description, next_action, next_action_date, resolution_target, metadata)
    VALUES (${body.title}, ${body.counterparty}, ${body.dispute_type}, ${body.amount_claimed || null}, ${body.amount_at_stake || null}, ${body.status || 'open'}, ${body.priority || 5}, ${body.description || null}, ${body.next_action || null}, ${body.next_action_date || null}, ${body.resolution_target || null}, ${JSON.stringify(body.metadata || {})})
    RETURNING *
  `;
  // Fire-and-forget: push to ChittyLedger as a case
  const ledger = ledgerClient(c.env);
  if (ledger) {
    ledger.createCase({
      caseNumber: `CC-DISPUTE-${(dispute.id as string).slice(0, 8)}`,
      title: body.title,
      caseType: 'CIVIL',
      description: body.description || undefined,
    }).then((caseResult) => {
      if (caseResult?.id) {
        sql`UPDATE cc_disputes SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseResult.id })}::jsonb WHERE id = ${dispute.id}`.catch(() => {});
      }
    }).catch(() => {});
  }

  return c.json(dispute, 201);
});

// Update dispute
disputeRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = updateDisputeSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);
  const [dispute] = await sql`
    UPDATE cc_disputes SET
      status = COALESCE(${body.status ?? null}, status),
      priority = COALESCE(${body.priority ?? null}, priority),
      next_action = COALESCE(${body.next_action ?? null}, next_action),
      next_action_date = COALESCE(${body.next_action_date ?? null}, next_action_date),
      description = COALESCE(${body.description ?? null}, description),
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!dispute) return c.json({ error: 'Dispute not found' }, 404);
  return c.json(dispute);
});

// Add correspondence to dispute
disputeRoutes.post('/:id/correspondence', async (c) => {
  const disputeId = c.req.param('id');
  const raw = await c.req.json();
  const result = createCorrespondenceSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const sql = getDb(c.env);
  const [entry] = await sql`
    INSERT INTO cc_dispute_correspondence (dispute_id, direction, channel, subject, content, attachments)
    VALUES (${disputeId}, ${body.direction}, ${body.channel}, ${body.subject || null}, ${body.content || null}, ${JSON.stringify(body.attachments || [])})
    RETURNING *
  `;

  // Log the action
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status)
    VALUES ('correspondence', 'dispute', ${disputeId}, ${body.direction + ' via ' + body.channel + ': ' + (body.subject || 'No subject')}, 'completed')
  `;

  return c.json(entry, 201);
});
