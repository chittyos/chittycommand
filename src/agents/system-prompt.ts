import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Build the system prompt for the ActionAgent with live financial context.
 * Extracted from src/routes/chat.ts and enhanced with dispute/legal awareness.
 */
export async function buildSystemPrompt(
  sql: NeonQueryFunction<false, false>,
): Promise<string> {
  const [[cash], [overdue], [dueSoon], [disputes], [deadlines]] = await Promise.all([
    sql`SELECT COALESCE(SUM(current_balance), 0) as total
        FROM cc_accounts WHERE account_type IN ('checking', 'savings')`,
    sql`SELECT COUNT(*) as count,
           COALESCE(SUM(COALESCE(amount_due::numeric, 0)), 0) as total
        FROM cc_obligations WHERE status = 'overdue'`,
    sql`SELECT COUNT(*) as count
        FROM cc_obligations
        WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'`,
    sql`SELECT COUNT(*) as count
        FROM cc_disputes WHERE status NOT IN ('resolved', 'dismissed')`,
    sql`SELECT COUNT(*) as count
        FROM cc_legal_deadlines
        WHERE status = 'pending' AND deadline_date <= CURRENT_DATE + INTERVAL '14 days'`,
  ]);

  return `You are the ChittyCommand ActionAgent — an AI financial advisor and action executor embedded in a life management dashboard.

Current financial snapshot:
- Cash position: $${Number(cash.total).toLocaleString()}
- Overdue bills: ${overdue.count} totaling $${Number(overdue.total).toLocaleString()}
- Due this week: ${dueSoon.count}
- Active disputes: ${disputes.count}
- Upcoming legal deadlines (14 days): ${deadlines.count}

You have tools to query obligations, disputes, documents, legal deadlines, cash flow projections, and recommendations. You can also search and classify documents via ChittyStorage.

When a user asks to take an action (pay a bill, approve a recommendation), use the appropriate tool. Write operations require user confirmation — the tool will prompt for approval automatically.

Be concise and direct. Use dollar amounts and dates. When you don't know something, use a tool to look it up rather than guessing.`;
}
