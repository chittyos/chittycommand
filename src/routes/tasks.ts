import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import {
  createTaskSchema,
  updateTaskStatusSchema,
  verifyTaskSchema,
  spawnRecommendationFromTaskSchema,
  taskQuerySchema,
  notionWebhookPayloadSchema,
} from '../lib/validators';

export const taskRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Valid state transitions: from -> allowed targets
const STATE_MACHINE: Record<string, string[]> = {
  queued: ['running', 'failed'],
  running: ['needs_review', 'failed'],
  needs_review: ['verified', 'failed'],
  verified: ['done', 'failed'],
  failed: ['queued'],
};

// ── POST /webhook — Notion webhook ingestion (dedupe on external_id)
taskRoutes.post('/webhook', async (c) => {
  const body = await c.req.json();
  const parsed = notionWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const sql = getDb(c.env);

  // Upsert by external_id — don't overwrite terminal states
  const rows = await sql`
    INSERT INTO cc_tasks (external_id, notion_page_id, title, description, task_type, source, priority, assigned_to, due_date, verification_type, metadata)
    VALUES (
      ${data.external_id},
      ${data.notion_page_id || null},
      ${data.title},
      ${data.description || null},
      ${data.task_type || 'general'},
      ${data.source || 'notion'},
      ${data.priority || 5},
      ${data.assigned_to || null},
      ${data.due_date || null},
      ${data.verification_type || 'soft'},
      ${JSON.stringify(data.metadata || {})}::jsonb
    )
    ON CONFLICT (external_id) DO UPDATE SET
      title = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.title ELSE cc_tasks.title END,
      description = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.description ELSE cc_tasks.description END,
      task_type = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.task_type ELSE cc_tasks.task_type END,
      priority = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.priority ELSE cc_tasks.priority END,
      assigned_to = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.assigned_to ELSE cc_tasks.assigned_to END,
      due_date = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.due_date ELSE cc_tasks.due_date END,
      verification_type = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.verification_type ELSE cc_tasks.verification_type END,
      notion_page_id = COALESCE(EXCLUDED.notion_page_id, cc_tasks.notion_page_id),
      metadata = CASE WHEN cc_tasks.backend_status NOT IN ('done', 'verified') THEN EXCLUDED.metadata ELSE cc_tasks.metadata END,
      updated_at = NOW()
    RETURNING *
  `;

  return c.json(rows[0], 201);
});

// ── GET / — List tasks with filters
taskRoutes.get('/', async (c) => {
  const query = taskQuerySchema.safeParse(Object.fromEntries(c.req.query() as unknown as Iterable<[string, string]>));
  if (!query.success) {
    return c.json({ error: 'Invalid query', details: query.error.flatten() }, 400);
  }

  const { status, task_type, source, priority_max, limit = 50, offset = 0 } = query.data;
  const sql = getDb(c.env);

  const rows = await sql`
    SELECT id, external_id, notion_page_id, title, description, task_type, source, priority,
           backend_status, assigned_to, due_date, verification_type, verification_artifact,
           verified_at, spawned_recommendation_id, ledger_record_id, metadata, created_at, updated_at
    FROM cc_tasks
    WHERE (${status || null}::text IS NULL OR backend_status = ${status || null})
      AND (${task_type || null}::text IS NULL OR task_type = ${task_type || null})
      AND (${source || null}::text IS NULL OR source = ${source || null})
      AND (${priority_max ?? null}::int IS NULL OR priority <= ${priority_max ?? null})
    ORDER BY priority ASC, due_date ASC NULLS LAST, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [countRow] = await sql`
    SELECT COUNT(*) as total FROM cc_tasks
    WHERE (${status || null}::text IS NULL OR backend_status = ${status || null})
      AND (${task_type || null}::text IS NULL OR task_type = ${task_type || null})
      AND (${source || null}::text IS NULL OR source = ${source || null})
      AND (${priority_max ?? null}::int IS NULL OR priority <= ${priority_max ?? null})
  `;

  return c.json({ tasks: rows, total: parseInt(countRow.total as string), limit, offset });
});

// ── GET /:id — Single task with action history
taskRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const rows = await sql`SELECT * FROM cc_tasks WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: 'Task not found' }, 404);

  // Fetch related action log entries if any
  const actions = await sql`
    SELECT id, action_type, description, status, executed_at
    FROM cc_actions_log
    WHERE target_type = 'task' AND target_id = ${id}
    ORDER BY executed_at DESC
    LIMIT 20
  `;

  return c.json({ task: rows[0], actions });
});

// ── PATCH /:id/status — Status transition with state machine validation
taskRoutes.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateTaskStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { status: newStatus, notes } = parsed.data;
  const sql = getDb(c.env);

  const rows = await sql`SELECT id, backend_status, verification_type, verification_artifact, ledger_record_id FROM cc_tasks WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: 'Task not found' }, 404);

  const task = rows[0] as { backend_status: string; verification_type: string; verification_artifact: string | null; ledger_record_id: string | null };
  const currentStatus = task.backend_status;

  // Validate transition
  const allowed = STATE_MACHINE[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return c.json({
      error: 'Invalid status transition',
      current: currentStatus,
      requested: newStatus,
      allowed: allowed || [],
    }, 422);
  }

  // Verified requires verification_artifact
  if (newStatus === 'verified' && !task.verification_artifact) {
    return c.json({ error: 'Cannot move to verified without verification artifact. Use POST /:id/verify first.' }, 422);
  }

  // Hard verification also requires ledger_record_id
  if (newStatus === 'verified' && task.verification_type === 'hard' && !task.ledger_record_id) {
    return c.json({ error: 'Hard verification requires ledger_record_id. Use POST /:id/verify with ledger_record_id.' }, 422);
  }

  const updated = await sql`
    UPDATE cc_tasks SET backend_status = ${newStatus}, updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;

  // Log the transition
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
    VALUES ('status_transition', 'task', ${id}, ${`${currentStatus} -> ${newStatus}`}, 'completed',
            ${JSON.stringify({ notes: notes || null })}::jsonb)
  `;

  return c.json(updated[0]);
});

// ── POST /:id/verify — Verification gate
taskRoutes.post('/:id/verify', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = verifyTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { verification_artifact, verification_notes, ledger_record_id } = parsed.data;
  const sql = getDb(c.env);

  const rows = await sql`SELECT id, backend_status, verification_type FROM cc_tasks WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: 'Task not found' }, 404);

  const task = rows[0] as { backend_status: string; verification_type: string };

  // Must be in needs_review to verify
  if (task.backend_status !== 'needs_review') {
    return c.json({ error: 'Task must be in needs_review status to verify', current: task.backend_status }, 422);
  }

  // Hard verification requires ledger_record_id
  if (task.verification_type === 'hard' && !ledger_record_id) {
    return c.json({ error: 'Hard verification requires ledger_record_id' }, 422);
  }

  const updated = await sql`
    UPDATE cc_tasks SET
      verification_artifact = ${verification_artifact},
      verification_notes = ${verification_notes || null},
      ledger_record_id = ${ledger_record_id || null},
      verified_at = NOW(),
      backend_status = 'verified',
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;

  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
    VALUES ('verify', 'task', ${id}, ${`Verified with artifact: ${verification_artifact}`}, 'completed',
            ${JSON.stringify({ verification_notes, ledger_record_id: ledger_record_id || null })}::jsonb)
  `;

  return c.json(updated[0]);
});

// ── POST /:id/spawn-recommendation — Create recommendation from task for swipe queue
taskRoutes.post('/:id/spawn-recommendation', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = spawnRecommendationFromTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { rec_type, priority = 3, action_type, estimated_savings } = parsed.data;
  const sql = getDb(c.env);

  const rows = await sql`SELECT id, title, description, task_type FROM cc_tasks WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: 'Task not found' }, 404);

  const task = rows[0] as { id: string; title: string; description: string | null; task_type: string };

  // Check if already spawned
  const existing = await sql`SELECT spawned_recommendation_id FROM cc_tasks WHERE id = ${id} AND spawned_recommendation_id IS NOT NULL`;
  if (existing.length > 0) {
    return c.json({ error: 'Task already has a spawned recommendation', recommendation_id: existing[0].spawned_recommendation_id }, 409);
  }

  const [rec] = await sql`
    INSERT INTO cc_recommendations (rec_type, priority, title, reasoning, action_type, estimated_savings, status, metadata)
    VALUES (
      ${rec_type},
      ${priority},
      ${task.title},
      ${task.description || `Task-spawned recommendation from ${task.task_type} task`},
      ${action_type || null},
      ${estimated_savings || null},
      'active',
      ${JSON.stringify({ spawned_from_task: id })}::jsonb
    )
    RETURNING id
  `;

  await sql`
    UPDATE cc_tasks SET spawned_recommendation_id = ${rec.id}, updated_at = NOW()
    WHERE id = ${id}
  `;

  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
    VALUES ('spawn_recommendation', 'task', ${id}, ${`Spawned recommendation ${rec.id}`}, 'completed',
            ${JSON.stringify({ recommendation_id: rec.id, rec_type })}::jsonb)
  `;

  return c.json({ task_id: id, recommendation_id: rec.id }, 201);
});
