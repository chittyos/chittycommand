import type { NeonQueryFunction } from '@neondatabase/serverless';
import { typedRows } from './db';
import { computeUrgencyScore, urgencyLevel } from './urgency';

/**
 * AI Triage Engine for ChittyCommand.
 *
 * Three tiers:
 *   1. Deterministic: urgency scoring, deadline detection, cash flow math
 *   2. Rule-based: recommendation generation from scored data
 *   3. AI-enhanced: Workers AI for document classification (future)
 *
 * Generates cc_recommendations with action_type and priority.
 */

export interface TriageResult {
  obligations_scored: number;
  recommendations_created: number;
  overdue_flipped: number;
  cash_position: { total_cash: number; total_due_30d: number; surplus: number };
}

interface Obligation {
  id: string;
  category: string;
  payee: string;
  amount_due: string | null;
  amount_minimum: string | null;
  due_date: string;
  status: string;
  auto_pay: boolean;
  negotiable: boolean;
  late_fee: string | null;
  grace_period_days: number;
  urgency_score: number | null;
  action_type: string | null;
  recurrence: string | null;
}

interface Dispute {
  id: string;
  title: string;
  counterparty: string;
  amount_at_stake: string | null;
  status: string;
  priority: number;
  next_action: string | null;
  next_action_date: string | null;
}

interface Deadline {
  id: string;
  title: string;
  case_ref: string;
  deadline_date: string;
  status: string;
}

export async function runTriage(sql: NeonQueryFunction<false, false>): Promise<TriageResult> {
  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 86400000);

  // ── 1. Score all active obligations ──────────────────────
  const obligations = typedRows<Obligation>(await sql`
    SELECT * FROM cc_obligations WHERE status IN ('pending', 'overdue')
  `);

  let overdue_flipped = 0;
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
    let newStatus = ob.status;
    if (dueDate < now && ob.status === 'pending') {
      newStatus = 'overdue';
      overdue_flipped++;
    }

    updates.push({ id: ob.id, score, status: newStatus });
  }

  // Batch update urgency scores
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

  // ── 2. Compute cash position ─────────────────────────────
  const [cashRow] = await sql`
    SELECT COALESCE(SUM(current_balance), 0) as total
    FROM cc_accounts WHERE account_type IN ('checking', 'savings')
  `;
  const totalCash = parseFloat(cashRow?.total || '0');

  const [dueRow] = await sql`
    SELECT COALESCE(SUM(COALESCE(amount_due, amount_minimum, 0)), 0) as total
    FROM cc_obligations
    WHERE status IN ('pending', 'overdue') AND due_date <= ${in30d.toISOString().slice(0, 10)}
  `;
  const totalDue30d = parseFloat(dueRow?.total || '0');
  const surplus = totalCash - totalDue30d;

  // ── 3. Load disputes and deadlines ───────────────────────
  const disputes = typedRows<Dispute>(await sql`
    SELECT * FROM cc_disputes WHERE status = 'open' ORDER BY priority ASC
  `);

  const deadlines = typedRows<Deadline>(await sql`
    SELECT * FROM cc_legal_deadlines WHERE status = 'upcoming' AND deadline_date > NOW() ORDER BY deadline_date ASC
  `);

  // ── 4. Expire old recommendations ────────────────────────
  await sql`
    UPDATE cc_recommendations SET status = 'expired'
    WHERE status = 'active' AND created_at < NOW() - INTERVAL '7 days'
  `;

  // ── 5. Generate recommendations ──────────────────────────
  const recs: {
    obligation_id: string | null;
    dispute_id: string | null;
    rec_type: string;
    priority: number;
    title: string;
    reasoning: string;
    action_type: string;
    estimated_savings: number | null;
  }[] = [];

  // Sort obligations by score descending
  const scored = updates.sort((a, b) => b.score - a.score);

  for (const entry of scored) {
    const ob = obligations.find(o => o.id === entry.id);
    if (!ob) continue;

    const level = urgencyLevel(entry.score);
    const amount = parseFloat(ob.amount_due || ob.amount_minimum || '0');
    const daysUntil = Math.floor((new Date(ob.due_date).getTime() - now.getTime()) / 86400000);

    // Critical/overdue: PAY NOW
    if (level === 'critical' && !ob.auto_pay) {
      recs.push({
        obligation_id: ob.id,
        dispute_id: null,
        rec_type: 'payment',
        priority: 1,
        title: `Pay ${ob.payee} immediately`,
        reasoning: daysUntil < 0
          ? `${ob.payee} is ${Math.abs(daysUntil)} days overdue. ${ob.late_fee ? `Late fee: $${ob.late_fee}.` : ''} Pay now to avoid further penalties.`
          : `${ob.payee} is due today. ${ob.category === 'mortgage' ? 'Missing mortgage payments damages credit score.' : 'Avoid late fees by paying now.'}`,
        action_type: ob.action_type || 'pay_now',
        estimated_savings: ob.late_fee ? parseFloat(ob.late_fee) : null,
      });
    }

    // High urgency + negotiable: NEGOTIATE
    if (level === 'high' && ob.negotiable && amount > 100) {
      recs.push({
        obligation_id: ob.id,
        dispute_id: null,
        rec_type: 'negotiate',
        priority: 3,
        title: `Negotiate ${ob.payee} — potential savings`,
        reasoning: `${ob.payee} is marked negotiable with $${amount} due. Call to request a lower rate, waived fees, or payment plan.`,
        action_type: 'negotiate',
        estimated_savings: amount * 0.15, // estimate 15% savings from negotiation
      });
    }

    // Cash-tight + low-priority: DEFER
    if (surplus < 0 && level === 'medium' && !ob.auto_pay && ob.category !== 'mortgage' && ob.category !== 'legal') {
      recs.push({
        obligation_id: ob.id,
        dispute_id: null,
        rec_type: 'defer',
        priority: 5,
        title: `Defer ${ob.payee} — cash is tight`,
        reasoning: `Cash surplus is -$${Math.abs(surplus).toFixed(0)}. ${ob.payee} ($${amount}) due in ${daysUntil} days is lower priority. Consider deferring to protect critical payments.`,
        action_type: 'defer',
        estimated_savings: null,
      });
    }

    // Minimum payment suggestion for credit cards with high balance
    if (ob.category === 'credit_card' && ob.amount_minimum && ob.amount_due && amount > parseFloat(ob.amount_minimum)) {
      const minAmt = parseFloat(ob.amount_minimum);
      if (surplus < 500) {
        recs.push({
          obligation_id: ob.id,
          dispute_id: null,
          rec_type: 'strategy',
          priority: 4,
          title: `Pay minimum on ${ob.payee} ($${minAmt})`,
          reasoning: `Cash is limited. Pay minimum $${minAmt} instead of full $${amount} on ${ob.payee} to preserve cash for higher-priority obligations.`,
          action_type: 'pay_minimum',
          estimated_savings: amount - minAmt,
        });
      }
    }
  }

  // Dispute recommendations
  for (const d of disputes) {
    if (d.next_action) {
      recs.push({
        obligation_id: null,
        dispute_id: d.id,
        rec_type: 'dispute',
        priority: d.priority <= 2 ? 2 : 4,
        title: `${d.counterparty}: ${d.next_action}`,
        reasoning: `Active dispute with ${d.counterparty}${d.amount_at_stake ? ` ($${parseFloat(d.amount_at_stake).toLocaleString()} at stake)` : ''}. Next step: ${d.next_action}.`,
        action_type: d.next_action_date && new Date(d.next_action_date) < in30d ? 'execute_action' : 'plan_action',
        estimated_savings: d.amount_at_stake ? parseFloat(d.amount_at_stake) : null,
      });
    }
  }

  // Legal deadline recommendations
  for (const dl of deadlines) {
    const dlDate = new Date(dl.deadline_date);
    const daysUntil = Math.floor((dlDate.getTime() - now.getTime()) / 86400000);

    if (daysUntil <= 14) {
      recs.push({
        obligation_id: null,
        dispute_id: null,
        rec_type: 'legal',
        priority: daysUntil <= 3 ? 1 : 2,
        title: `Prepare for: ${dl.title}`,
        reasoning: `${dl.case_ref} — ${dl.title} in ${daysUntil} days (${dlDate.toLocaleDateString()}). Ensure documents are filed and preparation is complete.`,
        action_type: 'prepare_legal',
        estimated_savings: null,
      });
    }
  }

  // Cash flow warning
  if (surplus < 0) {
    recs.push({
      obligation_id: null,
      dispute_id: null,
      rec_type: 'warning',
      priority: 1,
      title: `Cash shortfall: -$${Math.abs(surplus).toFixed(0)} in 30 days`,
      reasoning: `Available cash ($${totalCash.toFixed(0)}) doesn't cover 30-day obligations ($${totalDue30d.toFixed(0)}). Review deferrals, negotiate payment plans, or accelerate receivables.`,
      action_type: 'review_cashflow',
      estimated_savings: null,
    });
  }

  // ── 6. Write recommendations (dedup by title) ───────────
  let created = 0;
  for (const rec of recs) {
    // Skip if an active recommendation with the same title already exists
    const [existing] = await sql`
      SELECT id FROM cc_recommendations WHERE title = ${rec.title} AND status = 'active'
    `;
    if (existing) continue;

    await sql`
      INSERT INTO cc_recommendations (obligation_id, dispute_id, rec_type, priority, title, reasoning, action_type, estimated_savings, model_version)
      VALUES (${rec.obligation_id}, ${rec.dispute_id}, ${rec.rec_type}, ${rec.priority}, ${rec.title}, ${rec.reasoning}, ${rec.action_type}, ${rec.estimated_savings}, 'triage-v1')
    `;
    created++;
  }

  return {
    obligations_scored: updates.length,
    recommendations_created: created,
    overdue_flipped,
    cash_position: { total_cash: totalCash, total_due_30d: totalDue30d, surplus },
  };
}
