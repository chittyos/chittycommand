import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { scrapeClient, routerClient } from './integrations';
import { fanOutScrapeResult } from './fan-out';

export type ScrapeJobType =
  | 'court_docket'
  | 'cook_county_tax'
  | 'mr_cooper'
  | 'portal_scrape';

export type ScrapeJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'dead_letter';

export interface EnqueueOptions {
  chittyId?: string;
  maxAttempts?: number;
  scheduledAt?: Date;
  cronSource?: string;
  parentJobId?: string;
}

export interface ScrapeJob {
  id: string;
  chittyId: string | null;
  jobType: ScrapeJobType;
  target: Record<string, unknown>;
  status: ScrapeJobStatus;
  attempt: number;
  maxAttempts: number;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  parentJobId: string | null;
  cronSource: string | null;
  createdAt: string;
}

/**
 * Enqueue a new scrape job. Returns the job ID.
 */
export async function enqueueJob(
  sql: NeonQueryFunction<false, false>,
  jobType: ScrapeJobType,
  target: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const scheduledAt = opts.scheduledAt?.toISOString() || new Date().toISOString();
  const [row] = await sql`
    INSERT INTO cc_scrape_jobs (job_type, target, chitty_id, max_attempts, scheduled_at, cron_source, parent_job_id)
    VALUES (
      ${jobType},
      ${JSON.stringify(target)}::jsonb,
      ${opts.chittyId || null},
      ${opts.maxAttempts || 3},
      ${scheduledAt},
      ${opts.cronSource || null},
      ${opts.parentJobId || null}
    )
    RETURNING id
  `;
  return row.id as string;
}

/**
 * Execute a single scrape job by ID.
 * Handles calling ChittyScrape, persisting results, and updating job status.
 */
export async function executeJob(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  jobId: string,
  ctx?: ExecutionContext,
): Promise<{ success: boolean; recordsSynced: number }> {
  // Load the job
  const [job] = await sql`
    SELECT * FROM cc_scrape_jobs WHERE id = ${jobId}
  `;
  if (!job) throw new Error(`Job ${jobId} not found`);

  const jobType = job.job_type as ScrapeJobType;
  const target = job.target as Record<string, unknown>;
  const attempt = (job.attempt as number) + 1;
  const maxAttempts = job.max_attempts as number;

  // Mark running
  await sql`
    UPDATE cc_scrape_jobs
    SET status = 'running', attempt = ${attempt}, started_at = NOW()
    WHERE id = ${jobId}
  `;

  try {
    const result = await executeScrape(sql, env, jobType, target);

    // Mark completed
    await sql`
      UPDATE cc_scrape_jobs
      SET status = 'completed', result = ${JSON.stringify(result.data)}::jsonb, completed_at = NOW()
      WHERE id = ${jobId}
    `;

    // Fan out to downstream services (fire-and-forget)
    if (ctx) {
      ctx.waitUntil(fanOutScrapeResult(env, sql, {
        jobId,
        jobType,
        target,
        chittyId: job.chitty_id as string | null,
        result: result.data,
        recordsSynced: result.recordsSynced,
      }));
    }

    return { success: true, recordsSynced: result.recordsSynced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (attempt < maxAttempts) {
      // Schedule retry with exponential backoff: 30s, 60s, 120s...
      const backoffMs = 30000 * Math.pow(2, attempt - 1);
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      await sql`
        UPDATE cc_scrape_jobs
        SET status = 'retrying', error_message = ${errorMsg}, scheduled_at = ${retryAt}
        WHERE id = ${jobId}
      `;
    } else {
      // Dead letter
      await sql`
        UPDATE cc_scrape_jobs
        SET status = 'dead_letter', error_message = ${errorMsg}, completed_at = NOW()
        WHERE id = ${jobId}
      `;
    }

    return { success: false, recordsSynced: 0 };
  }
}

/**
 * Process the queue: pick up jobs that are ready to run and execute them.
 * Called from cron or manual trigger.
 */
export async function processQueue(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  ctx?: ExecutionContext,
  limit = 10,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const jobs = await sql`
    SELECT id FROM cc_scrape_jobs
    WHERE status IN ('queued', 'retrying')
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at
    LIMIT ${limit}
  `;

  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const result = await executeJob(sql, env, job.id as string, ctx);
      if (result.success) succeeded++;
      else failed++;
    } catch (err) {
      console.error(`[dispatcher] Job ${job.id} threw:`, err);
      failed++;
    }
  }

  return { processed: jobs.length, succeeded, failed };
}

/**
 * Get job status by ID.
 */
export async function getJobStatus(
  sql: NeonQueryFunction<false, false>,
  jobId: string,
): Promise<ScrapeJob | null> {
  const [row] = await sql`SELECT * FROM cc_scrape_jobs WHERE id = ${jobId}`;
  return row ? mapJobRow(row) : null;
}

/**
 * List jobs with optional filters.
 */
export async function listJobs(
  sql: NeonQueryFunction<false, false>,
  filters: {
    status?: ScrapeJobStatus;
    jobType?: ScrapeJobType;
    chittyId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ jobs: ScrapeJob[]; total: number }> {
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  // Build dynamic WHERE conditions
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(filters.status);
  }
  if (filters.jobType) {
    conditions.push(`job_type = $${params.length + 1}`);
    params.push(filters.jobType);
  }
  if (filters.chittyId) {
    conditions.push(`chitty_id = $${params.length + 1}`);
    params.push(filters.chittyId);
  }

  // Use tagged template for the common case (no filters or single filter)
  let rows: any[];
  let countRows: any[];

  if (!filters.status && !filters.jobType && !filters.chittyId) {
    rows = await sql`
      SELECT * FROM cc_scrape_jobs ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    countRows = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs`;
  } else if (filters.status && !filters.jobType && !filters.chittyId) {
    rows = await sql`
      SELECT * FROM cc_scrape_jobs WHERE status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    countRows = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs WHERE status = ${filters.status}`;
  } else if (filters.jobType && !filters.status && !filters.chittyId) {
    rows = await sql`
      SELECT * FROM cc_scrape_jobs WHERE job_type = ${filters.jobType}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    countRows = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs WHERE job_type = ${filters.jobType}`;
  } else {
    // Multiple filters — build with AND
    rows = await sql`
      SELECT * FROM cc_scrape_jobs
      WHERE (${filters.status || null}::text IS NULL OR status = ${filters.status || null})
        AND (${filters.jobType || null}::text IS NULL OR job_type = ${filters.jobType || null})
        AND (${filters.chittyId || null}::text IS NULL OR chitty_id = ${filters.chittyId || null})
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    countRows = await sql`
      SELECT COUNT(*)::int AS total FROM cc_scrape_jobs
      WHERE (${filters.status || null}::text IS NULL OR status = ${filters.status || null})
        AND (${filters.jobType || null}::text IS NULL OR job_type = ${filters.jobType || null})
        AND (${filters.chittyId || null}::text IS NULL OR chitty_id = ${filters.chittyId || null})
    `;
  }

  return {
    jobs: rows.map(mapJobRow),
    total: countRows[0]?.total || 0,
  };
}

/**
 * Get dead-lettered jobs for review.
 */
export async function getDeadLetters(
  sql: NeonQueryFunction<false, false>,
  limit = 50,
): Promise<ScrapeJob[]> {
  const rows = await sql`
    SELECT * FROM cc_scrape_jobs WHERE status = 'dead_letter'
    ORDER BY completed_at DESC LIMIT ${limit}
  `;
  return rows.map(mapJobRow);
}

/**
 * Retry a failed/dead-lettered job.
 */
export async function retryJob(
  sql: NeonQueryFunction<false, false>,
  jobId: string,
): Promise<boolean> {
  const [row] = await sql`
    UPDATE cc_scrape_jobs
    SET status = 'queued', attempt = 0, error_message = NULL,
        scheduled_at = NOW(), started_at = NULL, completed_at = NULL, result = NULL
    WHERE id = ${jobId} AND status IN ('failed', 'dead_letter')
    RETURNING id
  `;
  return !!row;
}

// ── Internal scrape execution ─────────────────────────────────

interface ScrapeResult {
  data: Record<string, unknown>;
  recordsSynced: number;
}

async function executeScrape(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  jobType: ScrapeJobType,
  target: Record<string, unknown>,
): Promise<ScrapeResult> {
  switch (jobType) {
    case 'court_docket':
      return executeCourtDocket(sql, env, target);
    case 'cook_county_tax':
      return executeCookCountyTax(sql, env, target);
    case 'mr_cooper':
      return executeMrCooper(sql, env, target);
    case 'portal_scrape':
      return executePortalScrape(sql, env, target);
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

async function executeCourtDocket(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  target: Record<string, unknown>,
): Promise<ScrapeResult> {
  const scrape = scrapeClient(env);
  if (!scrape) throw new Error('ChittyScrape not configured');

  const token = await env.COMMAND_KV.get('scrape:service_token');
  if (!token) throw new Error('No scrape:service_token in KV');

  const caseNumber = target.case_number as string;
  const result = await scrape.scrapeCourtDocket(caseNumber, token);
  if (!result?.success) throw new Error(result?.error || 'Scrape failed');

  let synced = 0;
  if (result.data?.entries) {
    for (const entry of result.data.entries) {
      await sql`
        INSERT INTO cc_legal_deadlines (case_ref, deadline_type, deadline_date, description, metadata)
        VALUES (${caseNumber}, ${entry.type || 'court_entry'}, ${entry.date || null}, ${entry.description || ''},
                ${JSON.stringify({ source: 'court_docket_scrape' })}::jsonb)
        ON CONFLICT DO NOTHING
      `;
      synced++;
    }
  }

  if (result.data?.nextHearing) {
    await sql`
      INSERT INTO cc_legal_deadlines (case_ref, deadline_type, deadline_date, description, metadata)
      VALUES (${caseNumber}, 'hearing', ${result.data.nextHearing}, 'Next court hearing',
              ${JSON.stringify({ source: 'court_docket_scrape' })}::jsonb)
      ON CONFLICT DO NOTHING
    `;
    synced++;
  }

  return { data: result.data || {}, recordsSynced: synced };
}

async function executeCookCountyTax(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  target: Record<string, unknown>,
): Promise<ScrapeResult> {
  const scrape = scrapeClient(env);
  if (!scrape) throw new Error('ChittyScrape not configured');

  const token = await env.COMMAND_KV.get('scrape:service_token');
  if (!token) throw new Error('No scrape:service_token in KV');

  const pin = target.pin as string;
  const propertyId = target.property_id as string | undefined;

  const taxResult = await scrape.scrapeCookCountyTax(pin, token);
  if (!taxResult?.success) throw new Error(taxResult?.error || 'Scrape failed');

  if (taxResult.data && propertyId) {
    await sql`
      UPDATE cc_properties
      SET annual_tax = ${taxResult.data.totalTax || 0},
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_tax_scrape}', ${JSON.stringify(taxResult.data)}::jsonb),
          updated_at = NOW()
      WHERE id = ${propertyId}
    `;
  } else if (taxResult.data) {
    await sql`
      UPDATE cc_properties
      SET annual_tax = ${taxResult.data.totalTax || 0},
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_tax_scrape}', ${JSON.stringify(taxResult.data)}::jsonb),
          updated_at = NOW()
      WHERE tax_pin = ${pin}
    `;
  }

  return { data: taxResult.data || {}, recordsSynced: 1 };
}

async function executeMrCooper(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  target: Record<string, unknown>,
): Promise<ScrapeResult> {
  const scrape = scrapeClient(env);
  if (!scrape) throw new Error('ChittyScrape not configured');

  const token = await env.COMMAND_KV.get('scrape:service_token');
  if (!token) throw new Error('No scrape:service_token in KV');

  const property = target.property as string;
  const result = await scrape.scrapeMrCooper(property, token);
  if (!result?.success) throw new Error(result?.error || 'Scrape failed');

  if (result.data) {
    await sql`
      UPDATE cc_obligations
      SET amount_due = ${result.data.monthlyPayment || result.data.currentBalance || 0},
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_scrape}', ${JSON.stringify(result.data)}::jsonb),
          updated_at = NOW()
      WHERE payee ILIKE '%mr. cooper%' OR payee ILIKE '%mr cooper%'
    `;
  }

  return { data: result.data || {}, recordsSynced: 1 };
}

async function executePortalScrape(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  target: Record<string, unknown>,
): Promise<ScrapeResult> {
  const router = routerClient(env);
  if (!router) throw new Error('ChittyRouter not configured');

  const portalTarget = target.portal as string;
  const result = await router.scrapePortal(portalTarget);
  if (!result?.success) throw new Error(result?.error || 'Portal scrape failed');

  let synced = 0;
  if (result.data && (result.data.amount || result.data.amount_due)) {
    const amount = Number(result.data.amount || result.data.amount_due || 0);
    const dueDate = (result.data.due_date || result.data.dueDate || null) as string | null;
    const payee = (result.data.payee || portalTarget) as string;
    const escapedPayee = payee.replace(/%/g, '\\%').replace(/_/g, '\\_');

    const [existing] = await sql`
      SELECT id FROM cc_obligations WHERE payee ILIKE ${`%${escapedPayee}%`} AND status IN ('pending', 'overdue') LIMIT 1
    `;

    if (existing) {
      await sql`
        UPDATE cc_obligations
        SET amount_due = ${amount},
            due_date = COALESCE(${dueDate}, due_date),
            metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{last_portal_scrape}', ${JSON.stringify(result.data)}::jsonb),
            updated_at = NOW()
        WHERE id = ${existing.id}
      `;
    } else if (dueDate) {
      await sql`
        INSERT INTO cc_obligations (category, payee, amount_due, due_date, status, metadata)
        VALUES ('utility', ${payee}, ${amount}, ${dueDate}, 'pending',
                ${JSON.stringify({ source: 'portal_scrape', last_portal_scrape: result.data })}::jsonb)
      `;
    }
    synced++;
  }

  return { data: result.data || {}, recordsSynced: synced };
}

// ── Helpers ────────────────────────────────────────────────────

function mapJobRow(row: Record<string, unknown>): ScrapeJob {
  return {
    id: row.id as string,
    chittyId: row.chitty_id as string | null,
    jobType: row.job_type as ScrapeJobType,
    target: row.target as Record<string, unknown>,
    status: row.status as ScrapeJobStatus,
    attempt: row.attempt as number,
    maxAttempts: row.max_attempts as number,
    scheduledAt: row.scheduled_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    result: row.result as Record<string, unknown> | null,
    errorMessage: row.error_message as string | null,
    parentJobId: row.parent_job_id as string | null,
    cronSource: row.cron_source as string | null,
    createdAt: row.created_at as string,
  };
}
