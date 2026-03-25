import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb, typedRows } from '../lib/db';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { listJobs, getJobStatus, retryJob, getDeadLetters, enqueueJob } from '../lib/job-dispatcher';
import type { ScrapeJobType, ScrapeJobStatus } from '../lib/job-dispatcher';
import { evidenceClient, ledgerClient } from '../lib/integrations';

/**
 * MCP (Model Context Protocol) server for ChittyCommand.
 *
 * Implements JSON-RPC 2.0 over HTTP (Streamable HTTP transport).
 * Provides 48 tools across 12 domains for Claude Code sessions.
 */

export const mcpRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const SERVER_INFO = {
  name: 'chittycommand-mcp',
  version: '0.1.0',
};

const TOOLS = [
  {
    name: 'get_canon_info',
    description: 'Return canonical service metadata (name, version, environment, registry info).',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_registry_status',
    description: 'Return ChittyRegister status including last beacon timestamp and status.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_schema_refs',
    description: 'Lightweight schema references: endpoints and db_tables.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'whoami',
    description: 'Identify the current MCP client identity and environment.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_context_summary',
    description: 'Return active context/persona if available (server-side).',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'ledger_stats',
    description: 'Summarize ledger linkage and service health.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'ledger_get_evidence',
    description: 'List evidence for a given case_id from ChittyLedger.',
    inputSchema: { type: 'object' as const, properties: { case_id: { type: 'string', description: 'Ledger case ID' } }, required: ['case_id'] },
  },
  {
    name: 'ledger_record_custody',
    description: 'Record a custody entry for an evidence_id.',
    inputSchema: { type: 'object' as const, properties: { evidence_id: { type: 'string' }, action: { type: 'string' }, notes: { type: 'string' } }, required: ['evidence_id','action'] },
  },
  {
    name: 'ledger_facts',
    description: 'List case facts from ChittyLedger if supported.',
    inputSchema: { type: 'object' as const, properties: { case_id: { type: 'string' } }, required: ['case_id'] },
  },
  {
    name: 'ledger_contradictions',
    description: 'List case contradictions from ChittyLedger if supported.',
    inputSchema: { type: 'object' as const, properties: { case_id: { type: 'string' } }, required: ['case_id'] },
  },
  {
    name: 'ledger_create_case_for_dispute',
    description: 'Create/link a Ledger case for a dispute and store ledger_case_id.',
    inputSchema: { type: 'object' as const, properties: { dispute_id: { type: 'string' } }, required: ['dispute_id'] },
  },
  {
    name: 'ledger_link_case_for_dispute',
    description: 'Link an existing Ledger case to a dispute by storing ledger_case_id.',
    inputSchema: { type: 'object' as const, properties: { dispute_id: { type: 'string' }, case_id: { type: 'string' } }, required: ['dispute_id','case_id'] },
  },
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
    description: 'List active disputes. Filter by status. Shows counterparty, amounts, priority, and next actions.',
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
  {
    name: 'connect_discover',
    description: 'Resolve a service URL via ChittyConnect discovery.',
    inputSchema: { type: 'object' as const, properties: { service: { type: 'string', description: 'Service name to discover' } }, required: ['service'] },
  },
  {
    name: 'chittychat_list_projects',
    description: 'List projects from ChittyChat data API (if configured).',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'chittychat_list_tasks',
    description: 'List tasks; optionally filter by project_id.',
    inputSchema: { type: 'object' as const, properties: { project_id: { type: 'string', description: 'Project ID to filter' } }, required: [] as string[] },
  },
  {
    name: 'chittychat_get_task',
    description: 'Get a single task by ID.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'schema_list_types',
    description: 'List available schema types from ChittySchema.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'schema_get',
    description: 'Get a schema by type from ChittySchema.',
    inputSchema: { type: 'object' as const, properties: { type: { type: 'string' } }, required: ['type'] },
  },
  {
    name: 'schema_validate',
    description: 'Validate data against a schema type via ChittySchema.',
    inputSchema: { type: 'object' as const, properties: { type: { type: 'string' }, data: { type: 'object' } }, required: ['type','data'] },
  },
  {
    name: 'schema_drift',
    description: 'Detect schema drift between service and canonical schema.',
    inputSchema: { type: 'object' as const, properties: { service: { type: 'string' }, version: { type: 'string' }, schema: { type: 'object' } }, required: ['service','schema'] },
  },
  {
    name: 'cert_verify',
    description: 'Verify a certificate via ChittyCertify.',
    inputSchema: { type: 'object' as const, properties: { certificate_id: { type: 'string' } }, required: ['certificate_id'] },
  },
  {
    name: 'register_requirements',
    description: 'Fetch ChittyRegister compliance requirements schema.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'query_legal_deadlines',
    description: 'List legal deadlines. Filter by status or dispute. Shows urgency scores and deadline types.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: upcoming, overdue, met, waived', enum: ['upcoming', 'overdue', 'met', 'waived'] },
        dispute_id: { type: 'string', description: 'Filter by linked dispute ID' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'query_documents',
    description: 'List stored documents. Filter by type or processing status. Shows gaps in document coverage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        doc_type: { type: 'string', description: 'Filter: bill, statement, contract, legal, receipt, correspondence, tax, insurance' },
        processing_status: { type: 'string', description: 'Filter: pending, processed, failed' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_payment_plan',
    description: 'Get current payment plan with schedule, warnings, and balance projections.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'query_revenue_sources',
    description: 'List revenue sources with monthly amounts, confidence, and next expected dates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: active, paused, ended', enum: ['active', 'paused', 'ended'] },
      },
      required: [],
    },
  },
  {
    name: 'get_sync_status',
    description: 'Get sync status for all data sources — shows last sync time, records synced, and errors.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'trigger_sync',
    description: 'Trigger a manual sync for a data source (plaid, finance, ledger, scrape).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Source to sync: plaid, finance, ledger, scrape, mercury' },
      },
      required: ['source'],
    },
  },
  {
    name: 'query_tasks',
    description: 'List tasks from the backend task system. Filter by status, type, source, or priority.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: queued, running, needs_review, verified, done, failed', enum: ['queued', 'running', 'needs_review', 'verified', 'done', 'failed'] },
        task_type: { type: 'string', description: 'Filter: general, financial, legal, administrative, maintenance, communication', enum: ['general', 'financial', 'legal', 'administrative', 'maintenance', 'communication'] },
        source: { type: 'string', description: 'Filter: notion, email, mention, manual, api' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_task',
    description: 'Get a single task by ID with its action history.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Task UUID' } }, required: ['id'] },
  },
  {
    name: 'update_task_status',
    description: 'Transition a task to a new status. Enforces state machine: queued->running->needs_review->verified->done. Failed can retry to queued.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task UUID' },
        status: { type: 'string', description: 'Target status', enum: ['queued', 'running', 'needs_review', 'verified', 'done', 'failed'] },
        notes: { type: 'string', description: 'Optional transition notes' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'verify_task',
    description: 'Attach a verification artifact to a task and mark it verified. Task must be in needs_review. Hard verification also requires ledger_record_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task UUID' },
        verification_artifact: { type: 'string', description: 'URL or reference to the verification artifact' },
        verification_notes: { type: 'string', description: 'Optional notes about the verification' },
        ledger_record_id: { type: 'string', description: 'Required for hard verification — ledger record reference' },
      },
      required: ['id', 'verification_artifact'],
    },
  },
  // ── Scrape Jobs ────────────────────────────────────────────
  {
    name: 'query_scrape_jobs',
    description: 'List scrape jobs with optional filters (status, type, chitty_id). Returns paginated results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status', enum: ['queued', 'running', 'completed', 'failed', 'retrying', 'dead_letter'] },
        type: { type: 'string', description: 'Filter by job type', enum: ['court_docket', 'cook_county_tax', 'mr_cooper', 'portal_scrape'] },
        chitty_id: { type: 'string', description: 'Filter by ChittyID' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [] as string[],
    },
  },
  {
    name: 'get_scrape_job',
    description: 'Get detailed status of a specific scrape job by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Scrape job UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'retry_scrape_job',
    description: 'Re-queue a failed or dead-lettered scrape job for retry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Scrape job UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_dead_letters',
    description: 'List scrape jobs that exhausted all retry attempts (dead-lettered).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [] as string[],
    },
  },
  {
    name: 'enqueue_scrape_job',
    description: 'Manually enqueue a new scrape job for execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_type: { type: 'string', description: 'Type of scrape', enum: ['court_docket', 'cook_county_tax', 'mr_cooper', 'portal_scrape'] },
        target: { type: 'object', description: 'Target parameters (e.g. {case_number}, {pin}, {property}, {portal})' },
        chitty_id: { type: 'string', description: 'Optional ChittyID to bind results to' },
      },
      required: ['job_type', 'target'],
    },
  },
  {
    name: 'synthesize_case_facts',
    description: 'Auto-pull verified facts from ChittyEvidence for a case and synthesize them into a structured litigation summary. Returns categorized facts with [GIVEN]/[DERIVED]/[UNKNOWN] tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'Case ID to pull facts for' },
        property: { type: 'string', description: 'Property address (optional context)' },
        additional_notes: { type: 'string', description: 'Extra notes to include in synthesis' },
      },
      required: ['case_id'],
    },
  },
  {
    name: 'get_case_timeline',
    description: 'Get a unified case timeline combining facts from ChittyEvidence, legal deadlines, disputes, and documents. Events are sorted chronologically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'Case ID to get timeline for' },
        start_date: { type: 'string', description: 'Optional start date filter (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Optional end date filter (YYYY-MM-DD)' },
      },
      required: ['case_id'],
    },
  },
  {
    name: 'get_case_facts',
    description: 'Get enriched facts for a case from ChittyEvidence (includes entities and amounts).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'Case ID' },
      },
      required: ['case_id'],
    },
  },
  {
    name: 'get_case_contradictions',
    description: 'Get contradictions detected in case evidence from ChittyEvidence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'Case ID' },
      },
      required: ['case_id'],
    },
  },
  {
    name: 'get_pending_facts',
    description: 'Get facts awaiting human review for a case.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'Case ID (optional, omit for all cases)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: [] as string[],
    },
  },
];

// MCP endpoint — handles JSON-RPC 2.0 requests
mcpRoutes.post('/', async (c) => {
  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  }

  const body = parsedBody as { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };

  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0' } });
  }

  const { method, id } = body;
  const params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params))
    ? body.params as Record<string, unknown>
    : undefined;

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
      const toolName = params?.name as string;
      const args = (params?.arguments || {}) as Record<string, unknown>;
      try {
        const sql = getDb(c.env);
        const userId = c.get('userId');
        const scopes = c.get('scopes');
        const result = await executeTool(c.env, sql, toolName, args, { userId, scopes });
        const content = [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }];

        return c.json({ jsonrpc: '2.0', id, result: { content } });
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

interface CallerContext { userId: string; scopes: string[] }

async function executeTool(env: Env, sql: NeonQueryFunction<false, false>, toolName: string, args: Record<string, unknown>, caller: CallerContext): Promise<unknown> {
  switch (toolName) {
    case 'get_canon_info': {
      const name = 'ChittyCommand';
      const version = '0.1.0';
      const environment = env.ENVIRONMENT || 'production';
      const registered_with = env.CHITTYREGISTER_URL || null;
      const service_id = await env.COMMAND_KV.get('register:service_id');
      const last_beacon_at = await env.COMMAND_KV.get('register:last_beacon_at');
      const last_status = await env.COMMAND_KV.get('register:last_beacon_status');
      return { name, version, environment, canonicalUri: 'chittycanon://core/services/chittycommand', registered_with, registration: { service_id, last_beacon_at, last_status } };
    }

    case 'get_registry_status': {
      const last_beacon_at = await env.COMMAND_KV.get('register:last_beacon_at');
      const last_status = await env.COMMAND_KV.get('register:last_beacon_status');
      return { last_beacon_at, last_status };
    }

    case 'get_schema_refs': {
      return {
        schemaVersion: '0.1.0',
        endpoints: [
          '/api/dashboard', '/api/accounts', '/api/obligations', '/api/disputes',
          '/api/recommendations', '/api/cashflow', '/api/legal', '/api/documents',
          '/api/sync', '/api/queue', '/api/payment-plan', '/api/revenue',
          '/api/email-connections', '/api/chat', '/api/tasks',
          '/api/bridge/plaid', '/api/bridge/finance', '/api/bridge/ledger',
          '/api/bridge/scrape', '/api/bridge/disputes', '/api/bridge/mercury',
          '/api/bridge/books', '/api/bridge/assets', '/api/bridge/status',
          '/api/v1/tokens', '/api/v1/context', '/api/v1/connect',
          '/auth', '/mcp',
        ],
        db_tables: [
          'cc_accounts', 'cc_obligations', 'cc_transactions', 'cc_properties',
          'cc_legal_deadlines', 'cc_disputes', 'cc_dispute_correspondence',
          'cc_documents', 'cc_recommendations', 'cc_actions_log',
          'cc_cashflow_projections', 'cc_decision_feedback', 'cc_revenue_sources',
          'cc_payment_plans', 'cc_sync_log', 'cc_tasks',
        ],
      };
    }

    case 'whoami': {
      return { client: caller.userId, scopes: caller.scopes };
    }

    case 'get_context_summary': {
      // Prefer a dedicated context for the caller, then global
      let raw = await env.COMMAND_KV.get(`context:user:${caller.userId}`);
      if (!raw) raw = await env.COMMAND_KV.get('context:global');
      if (!raw) return { label: null, persona: null, tags: [], updated_at: null };
      let payload: { label?: string | null; persona?: string | null; tags?: string[]; updated_at?: string };
      try {
        payload = JSON.parse(raw);
      } catch {
        return { label: null, persona: null, tags: [], updated_at: null, parse_error: true };
      }
      return { label: payload.label ?? null, persona: payload.persona ?? null, tags: payload.tags ?? [], updated_at: payload.updated_at ?? null };
    }
    case 'ledger_stats': {
      let documentsLinked = 0;
      let disputesLinked = 0;
      try {
        const [docsRow] = await sql`SELECT COUNT(*) AS c FROM cc_documents WHERE metadata ? 'ledger_evidence_id'`;
        const [disputesRow] = await sql`SELECT COUNT(*) AS c FROM cc_disputes WHERE metadata ? 'ledger_case_id'`;
        documentsLinked = parseInt(docsRow?.c ?? '0');
        disputesLinked = parseInt(disputesRow?.c ?? '0');
      } catch {
        // Schema may not support metadata jsonb queries yet
      }
      let health: { status: string; code?: number } = { status: 'not_configured' };
      if (env.CHITTYLEDGER_URL) {
        try {
          const res = await fetch(`${env.CHITTYLEDGER_URL}/health`, { signal: AbortSignal.timeout(3000) });
          health = { status: res.ok ? 'ok' : 'error', code: res.status };
        } catch {
          health = { status: 'unreachable' };
        }
      }
      return {
        documents_linked: documentsLinked,
        disputes_linked: disputesLinked,
        service: health,
      };
    }

    case 'ledger_get_evidence': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const ev = evidenceClient(env);
      if (!ev) return { error: 'ChittyEvidence not configured' };
      const facts = await ev.getEnrichedFacts(caseId);
      return { case_id: caseId, evidence: facts || [] };
    }

    case 'ledger_record_custody': {
      const evidenceId = String(args.evidence_id || '').trim();
      const action = String(args.action || '').trim();
      const notes = args.notes ? String(args.notes) : undefined;
      if (!evidenceId || !action) throw new Error('Missing arguments: evidence_id, action');
      const ev = evidenceClient(env);
      if (!ev) return { error: 'ChittyEvidence not configured' };
      const result = await ev.addCustodyEntry(evidenceId, { action, performedBy: 'mcp-client', notes });
      return { ok: !!result, result };
    }

    case 'ledger_facts': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const ev = evidenceClient(env);
      if (!ev) return { error: 'ChittyEvidence not configured', facts: [] };
      const facts = await ev.getStatementOfFacts(caseId);
      return { case_id: caseId, facts: facts || [] };
    }

    case 'ledger_contradictions': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const ev = evidenceClient(env);
      if (!ev) return { error: 'ChittyEvidence not configured', contradictions: [] };
      const contradictions = await ev.getContradictions(caseId);
      return { case_id: caseId, contradictions: contradictions || [] };
    }

    case 'ledger_create_case_for_dispute': {
      const disputeId = String(args.dispute_id || '').trim();
      if (!disputeId) throw new Error('Missing argument: dispute_id');
      const ledger = ledgerClient(env);
      if (!ledger) return { error: 'ChittyLedger not configured' };
      const rows = await sql`SELECT id, title, dispute_type, description, metadata FROM cc_disputes WHERE id = ${disputeId}`;
      if (rows.length === 0) throw new Error('Dispute not found');
      const d = rows[0] as any;
      const metadata = (d.metadata as any) || {};
      if (metadata.ledger_case_id) return { dispute_id: disputeId, case_id: metadata.ledger_case_id, linked: true };
      const caseRef = `CC-DISPUTE-${String(d.id).slice(0, 8)}`;
      const entryResult = await ledger.addEntry({
        entityType: 'audit',
        entityId: caseRef,
        action: 'dispute:created',
        actor: 'chittycommand',
        actorType: 'service',
        metadata: { title: String(d.title), caseType: 'CIVIL', description: d.description || undefined },
      });
      if (!entryResult) return { error: 'Failed to create ledger entry' };
      await sql`UPDATE cc_disputes SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseRef, ledger_entry_id: entryResult.id })}::jsonb WHERE id = ${disputeId}`;
      return { dispute_id: disputeId, case_id: caseRef, ledger_entry_id: entryResult.id, linked: true };
    }

    case 'ledger_link_case_for_dispute': {
      const disputeId = String(args.dispute_id || '').trim();
      const caseId = String(args.case_id || '').trim();
      if (!disputeId || !caseId) throw new Error('Missing arguments: dispute_id, case_id');
      const updated = await sql`UPDATE cc_disputes SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseId })}::jsonb WHERE id = ${disputeId} RETURNING id`;
      if (updated.length === 0) throw new Error(`Dispute not found: ${disputeId}`);
      return { dispute_id: disputeId, case_id: caseId, linked: true };
    }
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

    case 'connect_discover': {
      const service = String(args.service || '').trim();
      if (!service) throw new Error('Missing argument: service');
      const baseUrl = env.CHITTYCONNECT_URL;
      if (!baseUrl) return { error: 'ChittyConnect not configured' };
      const key = `connect:discover:${service}`;
      try {
        const cached = await env.COMMAND_KV.get(key);
        if (cached) {
          try { const obj = JSON.parse(cached) as { url?: string }; if (obj?.url) return { service, url: obj.url, cached: true }; } catch (err) { console.warn('[mcp/connect_discover] KV cache parse failed:', err); }
        }
      } catch (err) { console.warn('[mcp/connect_discover] KV read failed:', err); }
      try {
        const res = await fetch(`${baseUrl}/api/discover/${encodeURIComponent(service)}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return { error: `Service not found`, code: res.status };
        const data = await res.json() as { url: string };
        try { await env.COMMAND_KV.put(key, JSON.stringify({ url: data.url }), { expirationTtl: 300 }); } catch (err) { console.warn('[mcp/connect_discover] KV write failed:', err); }
        return { service, url: data.url };
      } catch (err) {
        return { error: String(err) };
      }
    }

    case 'chittychat_list_projects': {
      const base = env.CHITTYCHAT_DATA_API;
      if (!base) return { error: 'ChittyChat data API not configured' };
      try {
        const res = await fetch(`${base}/projects`, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to list projects', code: res.status };
        const data = await res.json();
        return { projects: data };
      } catch (err) { return { error: String(err) }; }
    }

    case 'chittychat_list_tasks': {
      const base = env.CHITTYCHAT_DATA_API;
      if (!base) return { error: 'ChittyChat data API not configured' };
      const pid = args.project_id ? String(args.project_id) : '';
      try {
        const url = pid ? `${base}/projects/${encodeURIComponent(pid)}/tasks` : `${base}/tasks`;
        const res = await fetch(url, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to list tasks', code: res.status };
        const data = await res.json();
        return { tasks: data };
      } catch (err) { return { error: String(err) }; }
    }

    case 'chittychat_get_task': {
      const base = env.CHITTYCHAT_DATA_API;
      if (!base) return { error: 'ChittyChat data API not configured' };
      const id = String(args.id || '').trim();
      if (!id) throw new Error('Missing argument: id');
      try {
        const res = await fetch(`${base}/tasks/${encodeURIComponent(id)}`, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to fetch task', code: res.status };
        const data = await res.json();
        return { task: data };
      } catch (err) { return { error: String(err) }; }
    }

    case 'schema_list_types': {
      const base = env.CHITTYSCHEMA_URL || 'https://schema.chitty.cc';
      try {
        const res = await fetch(`${base}/api/v1/schemas`, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to list schema types', code: res.status };
        return { types: await res.json() };
      } catch (err) { return { error: String(err) }; }
    }

    case 'schema_get': {
      const base = env.CHITTYSCHEMA_URL || 'https://schema.chitty.cc';
      const t = String(args.type || '').trim();
      if (!t) throw new Error('Missing argument: type');
      try {
        const res = await fetch(`${base}/api/v1/schemas/${encodeURIComponent(t)}`, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to get schema', code: res.status };
        return { type: t, schema: await res.json() };
      } catch (err) { return { error: String(err) }; }
    }

    case 'schema_validate': {
      const base = env.CHITTYSCHEMA_URL || 'https://schema.chitty.cc';
      const t = String(args.type || '').trim();
      const data = (args.data ?? {}) as Record<string, unknown>;
      if (!t) throw new Error('Missing argument: type');
      try {
        const res = await fetch(`${base}/api/v1/validate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
          body: JSON.stringify({ type: t, data }), signal: AbortSignal.timeout(5000)
        });
        const out = await res.json().catch(() => ({}));
        return res.ok ? { valid: true, result: out } : { valid: false, result: out, code: res.status };
      } catch (err) { return { error: String(err) }; }
    }

    case 'schema_drift': {
      const base = env.CHITTYSCHEMA_URL || 'https://schema.chitty.cc';
      const service = String(args.service || 'chittycommand');
      const version = String(args.version || '0.1.0');
      const schema = (args.schema ?? {}) as Record<string, unknown>;
      try {
        const res = await fetch(`${base}/api/v1/drift`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
          body: JSON.stringify({ service, version, schema }), signal: AbortSignal.timeout(5000)
        });
        const out = await res.json().catch(() => ({}));
        return res.ok ? { drift: out } : { error: 'Drift check failed', code: res.status, result: out };
      } catch (err) { return { error: String(err) }; }
    }

    case 'cert_verify': {
      const base = env.CHITTYCERT_URL || 'https://cert.chitty.cc';
      const certificate_id = String(args.certificate_id || '').trim();
      if (!certificate_id) throw new Error('Missing argument: certificate_id');
      try {
        const res = await fetch(`${base}/api/v1/verify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
          body: JSON.stringify({ certificate_id }), signal: AbortSignal.timeout(5000)
        });
        const out = await res.json().catch(() => ({}));
        return res.ok ? { valid: true, certificate: out } : { valid: false, result: out, code: res.status };
      } catch (err) { return { error: String(err) }; }
    }

    case 'register_requirements': {
      const base = env.CHITTYREGISTER_URL || 'https://register.chitty.cc';
      try {
        const res = await fetch(`${base}/api/v1/requirements`, { headers: { 'X-Source-Service': 'chittycommand' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: 'Failed to fetch requirements', code: res.status };
        return { requirements: await res.json() };
      } catch (err) { return { error: String(err) }; }
    }

    case 'query_legal_deadlines': {
      const status = args.status || null;
      const disputeId = args.dispute_id || null;
      const limit = Math.min(Number(args.limit) || 20, 50);
      const rows = await sql`
        SELECT d.id, d.case_ref, d.title, d.deadline_date, d.deadline_type, d.status, d.urgency_score,
               (d.metadata->>'dispute_id') AS dispute_id, disp.title AS dispute_title
        FROM cc_legal_deadlines d
        LEFT JOIN cc_disputes disp ON (d.metadata->>'dispute_id')::uuid = disp.id
        WHERE (${status}::text IS NULL OR d.status = ${status})
          AND (${disputeId}::text IS NULL OR d.metadata->>'dispute_id' = ${disputeId})
        ORDER BY d.deadline_date ASC NULLS LAST, d.urgency_score DESC NULLS LAST
        LIMIT ${limit}
      `;
      return { count: rows.length, deadlines: rows };
    }

    case 'query_documents': {
      const docType = args.doc_type || null;
      const processingStatus = args.processing_status || null;
      const limit = Math.min(Number(args.limit) || 20, 50);
      const rows = await sql`
        SELECT id, doc_type, filename, processing_status, linked_dispute_id, created_at
        FROM cc_documents
        WHERE (${docType}::text IS NULL OR doc_type = ${docType})
          AND (${processingStatus}::text IS NULL OR processing_status = ${processingStatus})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return { count: rows.length, documents: rows };
    }

    case 'get_payment_plan': {
      const rows = await sql`
        SELECT id, plan_type, horizon_days, starting_balance, ending_balance,
               lowest_balance, lowest_balance_date, total_inflows, total_outflows,
               total_late_fees_avoided, total_late_fees_risked, schedule, warnings,
               status, created_at
        FROM cc_payment_plans
        WHERE status IN ('active', 'draft')
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1
      `;
      if (rows.length === 0) return { plan: null, message: 'No active or draft payment plan. Generate one via POST /api/payment-plan/generate.' };
      const plan = rows[0] as Record<string, unknown>;
      for (const field of ['schedule', 'warnings']) {
        if (typeof plan[field] === 'string') {
          try { plan[field] = JSON.parse(plan[field] as string); } catch {}
        }
      }
      return { plan };
    }

    case 'query_revenue_sources': {
      const status = args.status || null;
      const rows = await sql`
        SELECT r.id, r.source, r.description, r.amount, r.recurrence,
               r.recurrence_day, r.next_expected_date, r.confidence, r.status,
               a.account_name, a.institution
        FROM cc_revenue_sources r
        LEFT JOIN cc_accounts a ON r.account_id = a.id
        WHERE (${status}::text IS NULL OR r.status = ${status})
        ORDER BY r.amount::numeric DESC
      `;
      const total = rows.reduce((s, r) => s + parseFloat((r as Record<string, unknown>).amount as string || '0'), 0);
      return { count: rows.length, total_monthly: Math.round(total * 100) / 100, sources: rows };
    }

    case 'get_sync_status': {
      const rows = await sql`
        SELECT source, status, records_synced, started_at, completed_at, error_message
        FROM cc_sync_log
        WHERE id IN (
          SELECT MAX(id) FROM cc_sync_log GROUP BY source
        )
        ORDER BY started_at DESC
      `;
      return { sources: rows };
    }

    case 'trigger_sync': {
      const source = String(args.source || '').trim();
      if (!source) throw new Error('Missing argument: source');
      const validSources = ['plaid', 'finance', 'ledger', 'scrape', 'mercury', 'books', 'assets'];
      if (!validSources.includes(source)) throw new Error(`Invalid source: ${source}. Valid: ${validSources.join(', ')}`);
      await sql`
        INSERT INTO cc_sync_log (source, sync_type, status, records_synced, started_at)
        VALUES (${source}, 'manual', 'triggered', 0, NOW())
      `;
      return { ok: true, source, message: `Sync triggered for ${source}. Check status with get_sync_status.` };
    }

    case 'query_tasks': {
      const status = args.status || null;
      const taskType = args.task_type || null;
      const source = args.source || null;
      const limit = Math.min(Number(args.limit) || 20, 50);
      const rows = await sql`
        SELECT id, external_id, title, task_type, source, priority, backend_status, assigned_to,
               due_date, verification_type, verified_at, created_at, updated_at
        FROM cc_tasks
        WHERE (${status}::text IS NULL OR backend_status = ${status})
          AND (${taskType}::text IS NULL OR task_type = ${taskType})
          AND (${source}::text IS NULL OR source = ${source})
        ORDER BY priority ASC, due_date ASC NULLS LAST, created_at DESC
        LIMIT ${limit}
      `;
      return { count: rows.length, tasks: rows };
    }

    case 'get_task': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('Missing argument: id');
      const rows = await sql`SELECT * FROM cc_tasks WHERE id = ${id}`;
      if (rows.length === 0) return { error: 'Task not found' };
      const actions = await sql`
        SELECT id, action_type, description, status, executed_at
        FROM cc_actions_log WHERE target_type = 'task' AND target_id = ${id}
        ORDER BY executed_at DESC LIMIT 20
      `;
      return { task: rows[0], actions };
    }

    case 'update_task_status': {
      const id = String(args.id || '').trim();
      const newStatus = String(args.status || '').trim();
      const notes = args.notes ? String(args.notes) : undefined;
      if (!id || !newStatus) throw new Error('Missing arguments: id, status');
      const validStatuses = ['queued', 'running', 'needs_review', 'verified', 'done', 'failed'];
      if (!validStatuses.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

      const taskRows = await sql`SELECT id, backend_status, verification_type, verification_artifact, ledger_record_id FROM cc_tasks WHERE id = ${id}`;
      if (taskRows.length === 0) throw new Error('Task not found');
      const task = taskRows[0] as { backend_status: string; verification_type: string; verification_artifact: string | null; ledger_record_id: string | null };

      const machine: Record<string, string[]> = {
        queued: ['running', 'failed'], running: ['needs_review', 'failed'],
        needs_review: ['verified', 'failed'], verified: ['done', 'failed'], failed: ['queued'],
      };
      const allowed = machine[task.backend_status];
      if (!allowed || !allowed.includes(newStatus)) {
        return { error: 'Invalid status transition', current: task.backend_status, requested: newStatus, allowed: allowed || [] };
      }
      if (newStatus === 'verified' && !task.verification_artifact) {
        return { error: 'Cannot verify without artifact. Use verify_task tool first.' };
      }
      if (newStatus === 'verified' && task.verification_type === 'hard' && !task.ledger_record_id) {
        return { error: 'Hard verification requires ledger_record_id' };
      }

      const updated = await sql`UPDATE cc_tasks SET backend_status = ${newStatus}, updated_at = NOW() WHERE id = ${id} RETURNING *`;
      await sql`
        INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
        VALUES ('status_transition', 'task', ${id}, ${`${task.backend_status} -> ${newStatus}`}, 'completed',
                ${JSON.stringify({ notes, via: 'mcp' })}::jsonb)
      `;
      return { ok: true, task: updated[0] };
    }

    case 'verify_task': {
      const id = String(args.id || '').trim();
      const artifact = String(args.verification_artifact || '').trim();
      const vNotes = args.verification_notes ? String(args.verification_notes) : undefined;
      const ledgerId = args.ledger_record_id ? String(args.ledger_record_id) : undefined;
      if (!id || !artifact) throw new Error('Missing arguments: id, verification_artifact');

      const taskRows = await sql`SELECT id, backend_status, verification_type FROM cc_tasks WHERE id = ${id}`;
      if (taskRows.length === 0) throw new Error('Task not found');
      const task = taskRows[0] as { backend_status: string; verification_type: string };

      if (task.backend_status !== 'needs_review') {
        return { error: 'Task must be in needs_review to verify', current: task.backend_status };
      }
      if (task.verification_type === 'hard' && !ledgerId) {
        return { error: 'Hard verification requires ledger_record_id' };
      }

      const updated = await sql`
        UPDATE cc_tasks SET verification_artifact = ${artifact}, verification_notes = ${vNotes || null},
          ledger_record_id = ${ledgerId || null}, verified_at = NOW(), backend_status = 'verified', updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `;
      await sql`
        INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
        VALUES ('verify', 'task', ${id}, ${`Verified via MCP: ${artifact}`}, 'completed',
                ${JSON.stringify({ verification_notes: vNotes, ledger_record_id: ledgerId })}::jsonb)
      `;
      return { ok: true, task: updated[0] };
    }

    // ── Scrape Job Tools ────────────────────────────────────
    case 'query_scrape_jobs': {
      const result = await listJobs(sql, {
        status: args.status as ScrapeJobStatus | undefined,
        jobType: args.type as ScrapeJobType | undefined,
        chittyId: args.chitty_id ? String(args.chitty_id) : undefined,
        limit: Math.min(Number(args.limit) || 20, 50),
      }, env);
      return result;
    }

    case 'get_scrape_job': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('Missing argument: id');
      const job = await getJobStatus(sql, id, env);
      if (!job) throw new Error('Scrape job not found');
      return job;
    }

    case 'retry_scrape_job': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('Missing argument: id');
      const success = await retryJob(sql, id, env);
      if (!success) throw new Error('Job not found or not in retryable state (must be failed or dead_letter)');
      return { ok: true, status: 'queued', message: 'Job re-queued for retry' };
    }

    case 'get_dead_letters': {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const jobs = await getDeadLetters(sql, limit, env);
      return { jobs, total: jobs.length };
    }

    case 'enqueue_scrape_job': {
      const jobType = String(args.job_type || '').trim() as ScrapeJobType;
      const target = args.target as Record<string, unknown>;
      if (!jobType || !target) throw new Error('Missing arguments: job_type, target');

      const validTypes: ScrapeJobType[] = ['court_docket', 'cook_county_tax', 'mr_cooper', 'portal_scrape'];
      if (!validTypes.includes(jobType)) throw new Error(`Invalid job_type. Must be one of: ${validTypes.join(', ')}`);

      const jobId = await enqueueJob(sql, jobType, target, {
        chittyId: args.chitty_id ? String(args.chitty_id) : undefined,
        cronSource: 'mcp',
      }, env);
      return { ok: true, id: jobId, status: 'queued' };
    }

    case 'synthesize_case_facts': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const evidence = evidenceClient(env);
      if (!evidence) return { error: 'ChittyEvidence not configured' };

      const facts = await evidence.getEnrichedFacts(caseId);
      if (!facts || facts.length === 0) {
        return { error: 'No facts found for this case', caseId };
      }

      // Format facts with tags
      const formatted = facts.map(f => {
        const tag = f.verification_status === 'verified' ? '[GIVEN]'
          : f.verification_status === 'extracted' ? '[DERIVED]'
          : '[UNKNOWN]';
        const date = f.fact_date ? `(${f.fact_date}) ` : '';
        const entities = f.entities?.map(e => `${e.name} [${e.role}]`).join(', ');
        const amounts = f.amounts?.map(a => `${a.currency}${a.amount_value}`).join(', ');
        return {
          tag,
          date: f.fact_date || null,
          type: f.fact_type,
          text: f.fact_text,
          confidence: f.confidence,
          entities: entities || null,
          amounts: amounts || null,
        };
      });

      return {
        caseId,
        factsUsed: facts.length,
        factsByVerification: {
          verified: formatted.filter(f => f.tag === '[GIVEN]').length,
          extracted: formatted.filter(f => f.tag === '[DERIVED]').length,
          unknown: formatted.filter(f => f.tag === '[UNKNOWN]').length,
        },
        facts: formatted,
        hint: 'Use the /draft endpoint or draft MCP tool with these facts to generate case correspondence.',
      };
    }

    case 'get_case_timeline': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const startDate = args.start_date ? String(args.start_date) : undefined;
      const endDate = args.end_date ? String(args.end_date) : undefined;
      const events: Array<Record<string, unknown>> = [];

      // Facts from ChittyEvidence
      const evidence = evidenceClient(env);
      if (evidence) {
        const facts = startDate && endDate
          ? await evidence.getFactsByDateRange(caseId, startDate, endDate)
          : await evidence.getEnrichedFacts(caseId);
        if (facts) {
          for (const f of facts) {
            if (!f.fact_date) continue;
            events.push({ id: `fact:${f.id}`, date: f.fact_date, type: 'fact', title: f.fact_text.slice(0, 120), factType: f.fact_type, confidence: f.confidence, status: f.verification_status });
          }
        }
      }

      // Deadlines from DB (with date filtering)
      try {
        let deadlines;
        if (startDate && endDate) {
          deadlines = await sql`SELECT id, title, deadline_date, deadline_type, status FROM cc_legal_deadlines WHERE case_ref = ${caseId} AND deadline_date >= ${startDate} AND deadline_date <= ${endDate} ORDER BY deadline_date ASC`;
        } else if (startDate) {
          deadlines = await sql`SELECT id, title, deadline_date, deadline_type, status FROM cc_legal_deadlines WHERE case_ref = ${caseId} AND deadline_date >= ${startDate} ORDER BY deadline_date ASC`;
        } else if (endDate) {
          deadlines = await sql`SELECT id, title, deadline_date, deadline_type, status FROM cc_legal_deadlines WHERE case_ref = ${caseId} AND deadline_date <= ${endDate} ORDER BY deadline_date ASC`;
        } else {
          deadlines = await sql`SELECT id, title, deadline_date, deadline_type, status FROM cc_legal_deadlines WHERE case_ref = ${caseId} ORDER BY deadline_date ASC`;
        }
        for (const d of deadlines) {
          events.push({ id: `deadline:${d.id}`, date: d.deadline_date, type: 'deadline', title: d.title, deadlineType: d.deadline_type, status: d.status });
        }
      } catch (err) { console.error('[mcp/get_case_timeline] deadlines query error:', err); }

      // Disputes from DB
      try {
        const disputes = await sql`SELECT id, title, status, dispute_type, created_at FROM cc_disputes WHERE metadata->>'case_ref' = ${caseId} OR metadata->>'ledger_case_id' = ${caseId}`;
        for (const d of disputes) {
          events.push({ id: `dispute:${d.id}`, date: d.created_at, type: 'dispute', title: d.title, status: d.status, disputeType: d.dispute_type });
        }
      } catch (err) { console.error('[mcp/get_case_timeline] disputes query error:', err); }

      // Documents already covered by ChittyEvidence facts above

      events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return { caseId, eventCount: events.length, events };
    }

    case 'get_case_facts': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const evidence = evidenceClient(env);
      if (!evidence) return { error: 'ChittyEvidence not configured' };
      const facts = await evidence.getEnrichedFacts(caseId);
      return { caseId, facts: facts || [] };
    }

    case 'get_case_contradictions': {
      const caseId = String(args.case_id || '').trim();
      if (!caseId) throw new Error('Missing argument: case_id');
      const evidence = evidenceClient(env);
      if (!evidence) return { error: 'ChittyEvidence not configured' };
      const contradictions = await evidence.getContradictions(caseId);
      return { caseId, contradictions: contradictions || [] };
    }

    case 'get_pending_facts': {
      const caseId = args.case_id ? String(args.case_id).trim() : undefined;
      const limit = Math.min(Number(args.limit) || 50, 100);
      const evidence = evidenceClient(env);
      if (!evidence) return { error: 'ChittyEvidence not configured' };
      const pending = await evidence.getPendingFacts(caseId, limit);
      return { caseId: caseId || 'all', pending: pending || [] };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
