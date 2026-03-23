import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { routerClient } from './integrations';
import type { ScrapeJobResponse } from './integrations';

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
 * Enqueue a scrape job via ChittyRouter ScrapeAgent.
 * Falls back to local Neon queue if router is unavailable.
 * Uses a pre-generated UUID to prevent double-enqueue on ambiguous failures.
 */
export async function enqueueJob(
  sql: NeonQueryFunction<false, false>,
  jobType: ScrapeJobType,
  target: Record<string, unknown>,
  opts: EnqueueOptions = {},
  env?: Env,
): Promise<string> {
  const jobId = crypto.randomUUID();

  // Proxy to ChittyRouter ScrapeAgent
  if (env) {
    const router = routerClient(env);
    if (router) {
      try {
        const result = await router.enqueueScrapeJob(jobType, target, {
          jobId,
          chittyId: opts.chittyId,
          maxAttempts: opts.maxAttempts,
          cronSource: opts.cronSource,
        });
        if (result?.id) return result.id;
        console.warn('[dispatcher] ScrapeAgent enqueue returned no ID, falling back to local queue');
      } catch (err: unknown) {
        // Only fall back on definitive connection errors (no response received).
        // If the server responded (e.g. timeout after response sent), do NOT
        // fall back — the job may already exist on the router side.
        const isConnectionError =
          err instanceof TypeError || // fetch network failure
          (err instanceof DOMException && err.name === 'AbortError');
        if (!isConnectionError) {
          console.error('[dispatcher] ScrapeAgent enqueue got server error, not falling back', err);
          throw err;
        }
        console.warn('[dispatcher] ScrapeAgent connection error, falling back to local queue', err);
      }
    }
  }

  // Fallback: local Neon queue (legacy path) — uses the same jobId to prevent duplicates
  const scheduledAt = opts.scheduledAt?.toISOString() || new Date().toISOString();
  const [row] = await sql`
    INSERT INTO cc_scrape_jobs (id, job_type, target, chitty_id, max_attempts, scheduled_at, cron_source, parent_job_id)
    VALUES (
      ${jobId},
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
 * Process the queue via ChittyRouter ScrapeAgent.
 * Falls back to logging a warning if router is unavailable.
 */
export async function processQueue(
  sql: NeonQueryFunction<false, false>,
  env: Env,
  ctx?: ExecutionContext,
  limit = 10,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const router = routerClient(env);
  if (router) {
    const result = await router.processScrapeQueue();
    if (result) return result;
    console.warn('[dispatcher] ScrapeAgent processQueue failed');
  }

  // Check for stuck local jobs when router is unavailable
  const [stuckCount] = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs WHERE status = 'queued'`;
  if (stuckCount?.total > 0) {
    console.warn(`[dispatcher] ${stuckCount.total} local jobs stuck in queue — router unavailable`);
  }
  return { processed: 0, succeeded: 0, failed: 0 };
}

/**
 * Get job status — queries ChittyRouter ScrapeAgent first, falls back to local Neon.
 */
export async function getJobStatus(
  sql: NeonQueryFunction<false, false>,
  jobId: string,
  env?: Env,
): Promise<ScrapeJob | null> {
  if (env) {
    const router = routerClient(env);
    if (router) {
      const result = await router.getScrapeJobStatus(jobId);
      if (result) return mapRouterJob(result);
    }
  }
  // Fallback: local Neon (historical jobs)
  const [row] = await sql`SELECT * FROM cc_scrape_jobs WHERE id = ${jobId}`;
  return row ? mapJobRow(row) : null;
}

/**
 * List jobs — queries ChittyRouter ScrapeAgent first, falls back to local Neon.
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
  env?: Env,
): Promise<{ jobs: ScrapeJob[]; total: number }> {
  if (env) {
    const router = routerClient(env);
    if (router) {
      const result = await router.listScrapeJobs({
        status: filters.status,
        jobType: filters.jobType,
        limit: filters.limit,
        chittyId: filters.chittyId,
        offset: filters.offset,
      });
      if (result) {
        return {
          jobs: result.jobs.map(mapRouterJob),
          total: result.total,
        };
      }
    }
  }
  // Fallback: local Neon (historical)
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;
  let rows: any[];
  let countRows: any[];

  if (!filters.status && !filters.jobType && !filters.chittyId) {
    rows = await sql`SELECT * FROM cc_scrape_jobs ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    countRows = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs`;
  } else if (filters.status && !filters.jobType && !filters.chittyId) {
    rows = await sql`SELECT * FROM cc_scrape_jobs WHERE status = ${filters.status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    countRows = await sql`SELECT COUNT(*)::int AS total FROM cc_scrape_jobs WHERE status = ${filters.status}`;
  } else {
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
 * Get dead-lettered jobs from ChittyRouter ScrapeAgent.
 */
export async function getDeadLetters(
  sql: NeonQueryFunction<false, false>,
  limit = 50,
  env?: Env,
): Promise<ScrapeJob[]> {
  if (env) {
    const router = routerClient(env);
    if (router) {
      const result = await router.getScrapeDeadLetters(limit);
      if (result) return result.jobs.map(mapRouterJob);
    }
  }
  // Fallback: local Neon
  const rows = await sql`
    SELECT * FROM cc_scrape_jobs WHERE status = 'dead_letter'
    ORDER BY completed_at DESC LIMIT ${limit}
  `;
  return rows.map(mapJobRow);
}

/**
 * Retry a failed/dead-lettered job via ChittyRouter ScrapeAgent.
 */
export async function retryJob(
  sql: NeonQueryFunction<false, false>,
  jobId: string,
  env?: Env,
): Promise<boolean> {
  if (env) {
    const router = routerClient(env);
    if (router) {
      const result = await router.retryScrapeJob(jobId);
      if (result) return true;
    }
  }
  // Fallback: local Neon
  const [row] = await sql`
    UPDATE cc_scrape_jobs
    SET status = 'queued', attempt = 0, error_message = NULL,
        scheduled_at = NOW(), started_at = NULL, completed_at = NULL, result = NULL
    WHERE id = ${jobId} AND status IN ('failed', 'dead_letter')
    RETURNING id
  `;
  return !!row;
}

// ── Mappers ──────────────────────────────────────────────────

function mapRouterJob(r: ScrapeJobResponse): ScrapeJob {
  return {
    id: r.id,
    chittyId: null,
    jobType: r.jobType as ScrapeJobType,
    target: r.target,
    status: r.status as ScrapeJobStatus,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    scheduledAt: r.createdAt,
    startedAt: null,
    completedAt: r.completedAt || null,
    result: r.result || null,
    errorMessage: r.error || null,
    parentJobId: null,
    cronSource: null,
    createdAt: r.createdAt,
  };
}

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
