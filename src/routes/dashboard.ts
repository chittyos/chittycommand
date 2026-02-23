import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

// Aggregated dashboard view
dashboardRoutes.get('/', async (c) => {
  const sql = getDb(c.env);

  const [accounts, obligations, disputes, deadlines, recommendations] = await Promise.all([
    sql`SELECT
      COALESCE(SUM(CASE WHEN account_type IN ('checking', 'savings') THEN current_balance ELSE 0 END), 0) as total_cash,
      COALESCE(SUM(CASE WHEN account_type IN ('credit_card', 'store_credit') THEN current_balance ELSE 0 END), 0) as total_credit_owed,
      COALESCE(SUM(CASE WHEN account_type = 'mortgage' THEN current_balance ELSE 0 END), 0) as total_mortgage,
      COALESCE(SUM(CASE WHEN account_type = 'loan' THEN current_balance ELSE 0 END), 0) as total_loans,
      COUNT(*) as account_count
    FROM cc_accounts`,

    sql`SELECT
      COUNT(*) FILTER (WHERE status = 'overdue') as overdue_count,
      COUNT(*) FILTER (WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days') as due_this_week,
      COUNT(*) FILTER (WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '30 days') as due_this_month,
      COALESCE(SUM(amount_due) FILTER (WHERE status IN ('pending', 'overdue') AND due_date <= CURRENT_DATE + INTERVAL '30 days'), 0) as total_due_30d
    FROM cc_obligations`,

    sql`SELECT id, title, counterparty, status, amount_at_stake, next_action, next_action_date, priority
    FROM cc_disputes WHERE status = 'open' ORDER BY priority ASC LIMIT 10`,

    sql`SELECT id, case_ref, title, deadline_date, deadline_type, status, urgency_score
    FROM cc_legal_deadlines WHERE deadline_date >= CURRENT_DATE AND status != 'completed'
    ORDER BY deadline_date ASC LIMIT 5`,

    sql`SELECT id, title, rec_type, priority, reasoning, action_type, obligation_id, dispute_id
    FROM cc_recommendations WHERE status = 'active'
    ORDER BY priority ASC LIMIT 10`,
  ]);

  const urgentObligations = await sql`
    SELECT id, payee, category, amount_due, due_date, status, urgency_score, action_type
    FROM cc_obligations
    WHERE status IN ('pending', 'overdue')
    ORDER BY urgency_score DESC NULLS LAST, due_date ASC
    LIMIT 10
  `;

  return c.json({
    summary: accounts[0],
    obligations: {
      ...obligations[0],
      urgent: urgentObligations,
    },
    disputes,
    deadlines,
    recommendations,
  });
});
