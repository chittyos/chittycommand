import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import { typedRows } from '../lib/db';
import { computeConfidence, getDecisionStats } from '../lib/learning';
import { queueDecisionSchema } from '../lib/validators';

export const swipeQueueRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

interface QueueItem {
  id: string;
  rec_type: string;
  priority: number;
  title: string;
  reasoning: string;
  action_type: string | null;
  estimated_savings: string | null;
  obligation_id: string | null;
  dispute_id: string | null;
  confidence: string | null;
  suggested_amount: string | null;
  suggested_account_id: string | null;
  escalation_risk: string | null;
  scenario_impact: unknown;
  // Joined fields
  obligation_payee: string | null;
  obligation_amount: string | null;
  obligation_due_date: string | null;
  obligation_category: string | null;
  obligation_status: string | null;
  obligation_late_fee: string | null;
  obligation_grace_days: number | null;
  obligation_auto_pay: boolean | null;
  dispute_title: string | null;
  dispute_counterparty: string | null;
  dispute_amount: string | null;
}

// GET /api/queue — next batch of actionable items
swipeQueueRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const limit = parseInt(c.req.query('limit') || '10', 10);

  const items = typedRows<QueueItem>(await sql`
    SELECT
      r.id, r.rec_type, r.priority, r.title, r.reasoning,
      r.action_type, r.estimated_savings, r.obligation_id, r.dispute_id,
      r.confidence, r.suggested_amount, r.suggested_account_id,
      r.escalation_risk, r.scenario_impact,
      o.payee AS obligation_payee,
      COALESCE(o.amount_due, o.amount_minimum) AS obligation_amount,
      o.due_date AS obligation_due_date,
      o.category AS obligation_category,
      o.status AS obligation_status,
      o.late_fee AS obligation_late_fee,
      o.grace_period_days AS obligation_grace_days,
      o.auto_pay AS obligation_auto_pay,
      d.title AS dispute_title,
      d.counterparty AS dispute_counterparty,
      d.amount_at_stake AS dispute_amount
    FROM cc_recommendations r
    LEFT JOIN cc_obligations o ON r.obligation_id = o.id
    LEFT JOIN cc_disputes d ON r.dispute_id = d.id
    WHERE r.status = 'active'
    ORDER BY r.priority ASC, r.created_at ASC
    LIMIT ${limit}
  `);

  // Enrich with live confidence from learning engine
  const enriched = await Promise.all(items.map(async (item) => {
    const liveConfidence = await computeConfidence(
      sql, item.rec_type, item.obligation_payee || undefined,
    );
    return {
      ...item,
      confidence: item.confidence ? parseFloat(item.confidence) : liveConfidence,
      live_confidence: liveConfidence,
    };
  }));

  return c.json(enriched);
});

// POST /api/queue/:id/decide — record a swipe decision
swipeQueueRoutes.post('/:id/decide', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = queueDecisionSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);

  const { decision, modified_action, session_id } = result.data;
  const sql = getDb(c.env);

  // Fetch the recommendation
  const [rec] = await sql`
    SELECT r.*, o.payee AS obligation_payee
    FROM cc_recommendations r
    LEFT JOIN cc_obligations o ON r.obligation_id = o.id
    WHERE r.id = ${id}::uuid AND r.status = 'active'
  `;
  if (!rec) return c.json({ error: 'Recommendation not found or already acted on' }, 404);
  const r = rec as Record<string, unknown>;

  // Record the decision
  await sql`
    INSERT INTO cc_decision_feedback (
      recommendation_id, obligation_id, decision, original_action,
      modified_action, confidence_at_decision, session_id, outcome_status
    ) VALUES (
      ${id}::uuid,
      ${r.obligation_id as string | null},
      ${decision},
      ${r.action_type as string | null},
      ${modified_action || null},
      ${r.confidence as number | null},
      ${session_id || null},
      ${decision === 'approved' ? 'pending' : null}
    )
  `;

  // Execute the decision — require 'admin' or 'chittycommand:execute' scope for approvals
  if (decision === 'approved') {
    const scopes = c.get('scopes') || [];
    if (!scopes.includes('admin') && !scopes.includes('chittycommand:execute')) {
      return c.json({ error: 'Insufficient permissions — chittycommand:execute scope required' }, 403);
    }
    // Mark recommendation as completed
    await sql`
      UPDATE cc_recommendations SET status = 'completed', acted_on_at = NOW()
      WHERE id = ${id}::uuid
    `;

    // Log the action
    await sql`
      INSERT INTO cc_actions_log (action_type, target_type, target_id, description, request_payload, status)
      VALUES (
        ${(modified_action || r.action_type) as string || 'approved'},
        'recommendation',
        ${id}::uuid,
        ${'Approved via action queue: ' + (r.title as string)},
        ${JSON.stringify({ decision, original_action: r.action_type, modified_action })},
        'completed'
      )
    `;

    // If it's a payment action tied to an obligation, mark obligation as paid
    const actionType = modified_action || r.action_type as string;
    if ((actionType === 'pay_now' || actionType === 'pay_full' || actionType === 'pay_minimum') && r.obligation_id) {
      await sql`
        UPDATE cc_obligations SET status = 'paid', updated_at = NOW()
        WHERE id = ${r.obligation_id as string}::uuid
      `;
    }

    // If it's a defer action, mark as deferred
    if (actionType === 'defer' && r.obligation_id) {
      await sql`
        UPDATE cc_obligations SET status = 'deferred', updated_at = NOW()
        WHERE id = ${r.obligation_id as string}::uuid
      `;
    }
  } else if (decision === 'rejected') {
    await sql`
      UPDATE cc_recommendations SET status = 'dismissed', acted_on_at = NOW()
      WHERE id = ${id}::uuid
    `;
  } else if (decision === 'deferred') {
    // Keep active but lower priority
    await sql`
      UPDATE cc_recommendations SET priority = LEAST(priority + 1, 10)
      WHERE id = ${id}::uuid
    `;
  }

  // Return next item in queue
  const [next] = await sql`
    SELECT r.id, r.title, r.rec_type, r.priority
    FROM cc_recommendations r
    WHERE r.status = 'active' AND r.id != ${id}::uuid
    ORDER BY r.priority ASC, r.created_at ASC
    LIMIT 1
  `;

  return c.json({ decided: id, decision, next: next || null });
});

// GET /api/queue/stats — session statistics
swipeQueueRoutes.get('/stats', async (c) => {
  const sql = getDb(c.env);
  const sessionId = c.req.query('session_id');
  const stats = await getDecisionStats(sql, sessionId || undefined);
  return c.json(stats);
});

// GET /api/queue/history — recent decisions
swipeQueueRoutes.get('/history', async (c) => {
  const sql = getDb(c.env);
  const limit = parseInt(c.req.query('limit') || '20', 10);

  const history = await sql`
    SELECT
      df.id, df.decision, df.original_action, df.modified_action,
      df.outcome_status, df.created_at,
      r.title, r.rec_type, r.estimated_savings,
      o.payee AS obligation_payee
    FROM cc_decision_feedback df
    LEFT JOIN cc_recommendations r ON df.recommendation_id = r.id
    LEFT JOIN cc_obligations o ON df.obligation_id = o.id
    ORDER BY df.created_at DESC
    LIMIT ${limit}
  `;

  return c.json(history);
});
