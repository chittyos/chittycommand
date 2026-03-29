import { tool } from 'ai';
import { z } from 'zod';
import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Create financial tools bound to a Neon SQL connection.
 * Each tool executes read-only or guarded-write queries against cc_* tables.
 */
export function createFinancialTools(sql: NeonQueryFunction<false, false>) {
  return {
    get_financial_snapshot: tool({
      description: 'Get current cash position, overdue bills, and upcoming obligations.',
      inputSchema: z.object({}),
      execute: async () => {
        const [[cash], [overdue], [dueSoon], [activeRecs]] = await Promise.all([
          sql`SELECT COALESCE(SUM(current_balance), 0) as total,
                     COUNT(*) as account_count
              FROM cc_accounts WHERE account_type IN ('checking', 'savings')`,
          sql`SELECT COUNT(*) as count,
                     COALESCE(SUM(COALESCE(amount_due::numeric, 0)), 0) as total
              FROM cc_obligations WHERE status = 'overdue'`,
          sql`SELECT COUNT(*) as count
              FROM cc_obligations
              WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'`,
          sql`SELECT COUNT(*) as count
              FROM cc_recommendations WHERE status = 'active'`,
        ]);
        return {
          cash_position: Number(cash.total),
          account_count: Number(cash.account_count),
          overdue_count: Number(overdue.count),
          overdue_total: Number(overdue.total),
          due_this_week: Number(dueSoon.count),
          pending_recommendations: Number(activeRecs.count),
        };
      },
    }),

    query_obligations: tool({
      description: 'Search obligations (bills) by status, category, or payee. Returns up to 20 results.',
      inputSchema: z.object({
        status: z.enum(['pending', 'overdue', 'paid', 'deferred']).optional().describe('Filter by status'),
        category: z.string().optional().describe('Filter by category (e.g., "mortgage", "utility", "insurance")'),
        payee: z.string().optional().describe('Search payee name (partial match)'),
      }),
      execute: async ({ status, category, payee }) => {
        // Build dynamic query with optional filters
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(status);
        }
        if (category) {
          conditions.push(`category ILIKE $${paramIdx++}`);
          params.push(`%${category}%`);
        }
        if (payee) {
          conditions.push(`payee ILIKE $${paramIdx++}`);
          params.push(`%${payee}%`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await sql(
          `SELECT id, payee, amount_due, due_date, status, category, auto_pay, urgency_score
           FROM cc_obligations ${where}
           ORDER BY due_date ASC NULLS LAST LIMIT 20`,
          params,
        );
        return { obligations: rows, count: rows.length };
      },
    }),

    query_disputes: tool({
      description: 'Search active disputes by status or type.',
      inputSchema: z.object({
        status: z.enum(['open', 'pending', 'escalated', 'resolved', 'dismissed']).optional(),
        dispute_type: z.string().optional().describe('Filter by dispute type'),
      }),
      execute: async ({ status, dispute_type }) => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(status);
        }
        if (dispute_type) {
          conditions.push(`dispute_type ILIKE $${paramIdx++}`);
          params.push(`%${dispute_type}%`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await sql(
          `SELECT id, title, counterparty, dispute_type, amount_claimed, stage, status, priority, next_action, next_action_date
           FROM cc_disputes ${where}
           ORDER BY priority ASC LIMIT 20`,
          params,
        );
        return { disputes: rows, count: rows.length };
      },
    }),

    get_recommendations: tool({
      description: 'Get active recommendations from the action queue, enriched with obligation details.',
      inputSchema: z.object({
        limit: z.number().min(1).max(20).optional().describe('Number of results (default 10)'),
      }),
      execute: async ({ limit }) => {
        const n = limit ?? 10;
        const rows = await sql`
          SELECT r.id, r.rec_type, r.priority, r.title, r.reasoning,
                 r.action_type, r.estimated_savings, r.confidence,
                 r.suggested_amount, r.escalation_risk,
                 o.payee, o.amount_due, o.due_date, o.category, o.status as ob_status
          FROM cc_recommendations r
          LEFT JOIN cc_obligations o ON r.obligation_id = o.id
          WHERE r.status = 'active'
          ORDER BY r.priority ASC
          LIMIT ${n}
        `;
        return { recommendations: rows, count: rows.length };
      },
    }),

    approve_action: tool({
      description: 'Approve a recommendation from the action queue. This is a WRITE operation that marks the recommendation as completed and logs the action. Use this when the user explicitly asks to approve or execute a recommendation.',
      inputSchema: z.object({
        recommendation_id: z.string().uuid().describe('The recommendation ID to approve'),
        action_notes: z.string().optional().describe('Optional notes about the action taken'),
      }),
      execute: async ({ recommendation_id, action_notes }) => {
        // Verify the recommendation exists and is active
        const [rec] = await sql`
          SELECT id, title, action_type FROM cc_recommendations
          WHERE id = ${recommendation_id}::uuid AND status = 'active'
        `;
        if (!rec) {
          return { success: false, error: 'Recommendation not found or already completed' };
        }

        // Mark as completed and log the action
        await sql`UPDATE cc_recommendations SET status = 'completed' WHERE id = ${recommendation_id}::uuid`;
        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status)
          VALUES ('recommendation_acted', 'recommendation', ${recommendation_id}, ${action_notes || rec.title}, 'completed')
        `;

        return { success: true, recommendation: rec.title, action_type: rec.action_type };
      },
    }),

    get_legal_deadlines: tool({
      description: 'Get upcoming legal deadlines within a specified number of days.',
      inputSchema: z.object({
        days_ahead: z.number().min(1).max(90).optional().describe('Days to look ahead (default 30)'),
      }),
      execute: async ({ days_ahead }) => {
        const days = days_ahead ?? 30;
        const rows = await sql`
          SELECT id, case_ref, title, deadline_type, deadline_date, status, urgency_score
          FROM cc_legal_deadlines
          WHERE status = 'pending'
            AND deadline_date <= CURRENT_DATE + (${days} || ' days')::interval
          ORDER BY deadline_date ASC
        `;
        return { deadlines: rows, count: rows.length };
      },
    }),

    get_cashflow_projection: tool({
      description: 'Get the latest cash flow projection showing expected inflows, outflows, and balance.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await sql`
          SELECT projection_date, projected_inflow, projected_outflow, projected_balance, confidence
          FROM cc_cashflow_projections
          ORDER BY projection_date ASC
          LIMIT 30
        `;
        return { projections: rows, count: rows.length };
      },
    }),
  };
}
