import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb, typedRows } from '../lib/db';
import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * MCP (Model Context Protocol) server for ChittyCommand.
 *
 * Implements JSON-RPC 2.0 over HTTP (Streamable HTTP transport).
 * Provides 6 tools for querying financial state from Claude Code sessions.
 */

export const mcpRoutes = new Hono<{ Bindings: Env }>();

const SERVER_INFO = {
  name: 'chittycommand-mcp',
  version: '0.1.0',
};

const TOOLS = [
  {
    name: 'query_obligations',
    description: 'List financial obligations (bills, payments, taxes). Filter by status, category, or urgency.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: pending, overdue, paid, deferred', enum: ['pending', 'overdue', 'paid', 'deferred'] },
        category: { type: 'string', description: 'Filter: mortgage, utility, credit, insurance, tax, legal, subscription, loan, hoa' },
        min_urgency: { type: 'number', description: 'Minimum urgency score (0-100)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'query_accounts',
    description: 'List financial accounts (bank, credit, mortgage, loan). Shows balances and sync status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_type: { type: 'string', description: 'Filter: checking, savings, credit_card, mortgage, loan, store_credit' },
      },
      required: [],
    },
  },
  {
    name: 'query_disputes',
    description: 'List active disputes (Xfinity, HOA, Fox Rental, etc). Shows status, amounts, next actions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: active, pending, resolved, escalated' },
      },
      required: [],
    },
  },
  {
    name: 'get_recommendations',
    description: 'Get AI triage recommendations — prioritized actions for bills, disputes, and financial strategy.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        priority: { type: 'number', description: 'Filter by max priority (1=critical, 5=low)' },
        rec_type: { type: 'string', description: 'Filter: payment, negotiate, defer, dispute, legal, strategy, warning' },
      },
      required: [],
    },
  },
  {
    name: 'get_cash_position',
    description: 'Get current financial snapshot: total cash, credit owed, mortgage balance, upcoming obligations, and 30-day outlook.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_cashflow_projections',
    description: 'Get 90-day cash flow projections with confidence scores. Shows when money gets tight.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
];

// MCP endpoint — handles JSON-RPC 2.0 requests
mcpRoutes.post('/', async (c) => {
  const body = await c.req.json() as { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> };

  if (body.jsonrpc !== '2.0') {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0' } });
  }

  const { method, params, id } = body;

  switch (method) {
    case 'initialize':
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });

    case 'notifications/initialized':
      // Per JSON-RPC 2.0: notifications have no id and MUST NOT receive a response
      return c.body(null, 204);

    case 'tools/list':
      return c.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const sql = getDb(c.env);
        const result = await executeTool(sql, toolName, args);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          },
        });
      }
    }

    default:
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
});

// GET for server info / health
mcpRoutes.get('/', (c) => {
  return c.json({ service: 'chittycommand-mcp', version: '0.1.0', transport: 'streamable-http', status: 'ok' });
});

// Tool execution — all queries use parameterized tagged templates
interface ProjectionRow {
  projection_date: string;
  projected_inflow: string;
  projected_outflow: string;
  projected_balance: string;
  obligations: string;
  confidence: string;
}

async function executeTool(sql: NeonQueryFunction<false, false>, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'query_obligations': {
      const status = args.status || null;
      const category = args.category || null;
      const minUrgency = args.min_urgency != null ? Number(args.min_urgency) : null;
      const limit = Math.min(Number(args.limit) || 20, 50);

      const rows = await sql`
        SELECT id, category, payee, amount_due, amount_minimum, due_date, recurrence, status, auto_pay, negotiable, urgency_score, action_type
        FROM cc_obligations
        WHERE (${status}::text IS NULL OR status = ${status})
          AND (${category}::text IS NULL OR category = ${category})
          AND (${minUrgency}::int IS NULL OR urgency_score >= ${minUrgency})
        ORDER BY urgency_score DESC NULLS LAST, due_date ASC
        LIMIT ${limit}
      `;
      return { count: rows.length, obligations: rows };
    }

    case 'query_accounts': {
      const accountType = args.account_type || null;
      const rows = await sql`
        SELECT id, source, account_name, account_type, institution, current_balance, credit_limit, interest_rate, last_synced_at
        FROM cc_accounts
        WHERE (${accountType}::text IS NULL OR account_type = ${accountType})
        ORDER BY account_type, account_name
      `;
      return { count: rows.length, accounts: rows };
    }

    case 'query_disputes': {
      const status = args.status || null;
      const rows = await sql`
        SELECT id, title, counterparty, dispute_type, amount_claimed, amount_at_stake, status, priority, next_action, next_action_date
        FROM cc_disputes
        WHERE (${status}::text IS NULL OR status = ${status})
        ORDER BY priority ASC, next_action_date ASC NULLS LAST
      `;
      return { count: rows.length, disputes: rows };
    }

    case 'get_recommendations': {
      const maxPriority = args.priority != null ? Number(args.priority) : null;
      const recType = args.rec_type || null;
      const rows = await sql`
        SELECT id, rec_type, priority, title, reasoning, action_type, estimated_savings
        FROM cc_recommendations
        WHERE status = 'active'
          AND (${maxPriority}::int IS NULL OR priority <= ${maxPriority})
          AND (${recType}::text IS NULL OR rec_type = ${recType})
        ORDER BY priority ASC, created_at DESC
        LIMIT 20
      `;
      return { count: rows.length, recommendations: rows };
    }

    case 'get_cash_position': {
      const [cash] = await sql`SELECT COALESCE(SUM(current_balance), 0) as total FROM cc_accounts WHERE account_type IN ('checking', 'savings')`;
      const [credit] = await sql`SELECT COALESCE(SUM(current_balance), 0) as total FROM cc_accounts WHERE account_type = 'credit_card'`;
      const [mortgage] = await sql`SELECT COALESCE(SUM(current_balance), 0) as total FROM cc_accounts WHERE account_type = 'mortgage'`;
      const [loans] = await sql`SELECT COALESCE(SUM(current_balance), 0) as total FROM cc_accounts WHERE account_type = 'loan'`;
      const [due30] = await sql`
        SELECT COALESCE(SUM(COALESCE(amount_due::numeric, amount_minimum::numeric, 0)), 0) as total
        FROM cc_obligations WHERE status IN ('pending', 'overdue') AND due_date <= CURRENT_DATE + INTERVAL '30 days'
      `;
      const [overdue] = await sql`SELECT COUNT(*) as count FROM cc_obligations WHERE status = 'overdue'`;
      const [dueWeek] = await sql`
        SELECT COUNT(*) as count, COALESCE(SUM(COALESCE(amount_due::numeric, amount_minimum::numeric, 0)), 0) as total
        FROM cc_obligations WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'
      `;

      const totalCash = parseFloat(cash.total);
      const totalDue30d = parseFloat(due30.total);

      return {
        cash: { total: totalCash, label: 'Checking + Savings' },
        credit_owed: parseFloat(credit.total),
        mortgage_balance: parseFloat(mortgage.total),
        loans_balance: parseFloat(loans.total),
        obligations_30d: { total: totalDue30d, overdue_count: parseInt(overdue.count) },
        due_this_week: { count: parseInt(dueWeek.count), total: parseFloat(dueWeek.total) },
        surplus_30d: Math.round((totalCash - totalDue30d) * 100) / 100,
        net_position: Math.round((totalCash - parseFloat(credit.total) - parseFloat(loans.total)) * 100) / 100,
      };
    }

    case 'get_cashflow_projections': {
      const rows = typedRows<ProjectionRow>(await sql`
        SELECT projection_date, projected_inflow, projected_outflow, projected_balance, obligations, confidence
        FROM cc_cashflow_projections
        WHERE generated_at >= NOW() - INTERVAL '2 days'
        ORDER BY projection_date ASC
      `);

      if (rows.length === 0) {
        return { message: 'No projections available. Generate them via POST /api/cashflow/generate first.', projections: [] };
      }

      let lowestBalance = Infinity;
      let lowestIdx = 0;
      const balances: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const b = parseFloat(rows[i].projected_balance);
        balances.push(b);
        if (b < lowestBalance) { lowestBalance = b; lowestIdx = i; }
      }

      return {
        days_covered: rows.length,
        starting_balance: balances[0],
        ending_balance: balances[balances.length - 1],
        lowest_balance: lowestBalance,
        lowest_balance_date: rows[lowestIdx].projection_date,
        projections: rows.map((r, i) => ({
          date: r.projection_date,
          balance: balances[i],
          inflow: parseFloat(r.projected_inflow),
          outflow: parseFloat(r.projected_outflow),
          confidence: parseFloat(r.confidence),
        })),
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
