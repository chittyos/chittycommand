import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { createDisputeSchema, updateDisputeSchema, createCorrespondenceSchema, disputeQuerySchema } from '../lib/validators';
import { fireDisputeSideEffects } from '../lib/dispute-sync';

export const disputeRoutes = new Hono<{ Bindings: Env }>();
const TERMINAL_STATUSES = new Set(['resolved', 'dismissed']);

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

// Get deadlines linked to this dispute (via ledger_case_id/case_ref metadata)
disputeRoutes.get('/:id/deadlines', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');

  const [dispute] = await sql`
    SELECT id, title, COALESCE(metadata->>'ledger_case_id', metadata->>'case_ref') AS case_ref
    FROM cc_disputes
    WHERE id = ${id}
  `;
  if (!dispute) return c.json({ error: 'Dispute not found' }, 404);

  const caseRef = (dispute as { case_ref: string | null }).case_ref;
  if (!caseRef) return c.json([]);

  const deadlines = await sql`
    SELECT *
    FROM cc_legal_deadlines
    WHERE case_ref = ${caseRef}
      AND status != 'completed'
    ORDER BY deadline_date ASC
  `;
  return c.json(deadlines);
});

// Create dispute
disputeRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createDisputeSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;
  const stage = body.stage || 'filed';
  const status = body.status || 'open';
  if (stage !== 'resolved' && status !== 'open') {
    return c.json({ error: 'Non-terminal stages must keep status=open' }, 400);
  }
  if (stage === 'resolved' && status === 'open') {
    return c.json({ error: 'stage=resolved requires status=resolved or status=dismissed' }, 400);
  }
  const sql = getDb(c.env);
  const [dispute] = await sql`
    INSERT INTO cc_disputes (title, counterparty, dispute_type, amount_claimed, amount_at_stake, stage, status, priority, description, next_action, next_action_date, resolution_target, metadata)
    VALUES (${body.title}, ${body.counterparty}, ${body.dispute_type}, ${body.amount_claimed || null}, ${body.amount_at_stake || null}, ${stage}, ${status}, ${body.priority || 5}, ${body.description || null}, ${body.next_action || null}, ${body.next_action_date || null}, ${body.resolution_target || null}, ${JSON.stringify(body.metadata || {})})
    RETURNING *
  `;
  // Fire-and-forget: Notion task, TriageAgent scoring, and ChittyLedger case
  c.executionCtx.waitUntil(
    fireDisputeSideEffects(
      {
        id: dispute.id as string,
        title: body.title,
        counterparty: body.counterparty,
        dispute_type: body.dispute_type,
        amount_at_stake: body.amount_at_stake ?? null,
        description: body.description ?? null,
        priority: (body.priority ?? 5) as number,
        metadata: (dispute.metadata as Record<string, unknown>) ?? {},
      },
      c.env,
      sql,
    )
  );

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
  const [existing] = await sql`SELECT * FROM cc_disputes WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Dispute not found' }, 404);

  const nextStage = (body.stage ?? existing.stage ?? 'filed') as string;
  const nextStatus = (body.status ?? existing.status ?? 'open') as string;
  if (nextStage !== 'resolved' && nextStatus !== 'open') {
    return c.json({ error: 'Non-terminal stages must keep status=open' }, 400);
  }
  if (nextStage === 'resolved' && !TERMINAL_STATUSES.has(nextStatus)) {
    return c.json({ error: 'stage=resolved requires status=resolved or status=dismissed' }, 400);
  }

  const [dispute] = await sql`
    UPDATE cc_disputes SET
      title = COALESCE(${body.title ?? null}, title),
      counterparty = COALESCE(${body.counterparty ?? null}, counterparty),
      dispute_type = COALESCE(${body.dispute_type ?? null}, dispute_type),
      amount_claimed = COALESCE(${body.amount_claimed ?? null}, amount_claimed),
      amount_at_stake = COALESCE(${body.amount_at_stake ?? null}, amount_at_stake),
      stage = ${nextStage},
      status = ${nextStatus},
      priority = COALESCE(${body.priority ?? null}, priority),
      next_action = COALESCE(${body.next_action ?? null}, next_action),
      next_action_date = COALESCE(${body.next_action_date ?? null}, next_action_date),
      description = COALESCE(${body.description ?? null}, description),
      resolution_target = COALESCE(${body.resolution_target ?? null}, resolution_target),
      metadata = COALESCE(${body.metadata ? JSON.stringify(body.metadata) : null}::jsonb, metadata),
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;

  if (body.stage || body.status) {
    await sql`
      INSERT INTO cc_actions_log (action_type, target_type, target_id, description, request_payload, status)
      VALUES (
        'dispute_lifecycle_update',
        'dispute',
        ${id},
        ${`Lifecycle update: stage=${nextStage}, status=${nextStatus}`},
        ${JSON.stringify({ before: { stage: existing.stage, status: existing.status }, after: { stage: nextStage, status: nextStatus } })},
        'completed'
      )
    `;
  }

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
