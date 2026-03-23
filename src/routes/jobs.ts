import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import {
  listJobs,
  getJobStatus,
  retryJob,
  getDeadLetters,
  enqueueJob,
  processQueue,
} from '../lib/job-dispatcher';
import type { ScrapeJobType, ScrapeJobStatus } from '../lib/job-dispatcher';

export const jobRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// List jobs with optional filters
jobRoutes.get('/jobs', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') as ScrapeJobStatus | undefined;
  const jobType = c.req.query('type') as ScrapeJobType | undefined;
  const chittyId = c.req.query('chitty_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const result = await listJobs(sql, { status, jobType, chittyId, limit, offset }, c.env);
  return c.json(result);
});

// Get single job status
jobRoutes.get('/jobs/:id', async (c) => {
  const sql = getDb(c.env);
  const job = await getJobStatus(sql, c.req.param('id'), c.env);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

// Get dead-lettered jobs
jobRoutes.get('/jobs/queue/dead-letter', async (c) => {
  const sql = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const jobs = await getDeadLetters(sql, limit, c.env);
  return c.json({ jobs, total: jobs.length });
});

// Retry a failed job
jobRoutes.post('/jobs/:id/retry', async (c) => {
  const sql = getDb(c.env);
  const success = await retryJob(sql, c.req.param('id'), c.env);
  if (!success) return c.json({ error: 'Job not found or not in retryable state' }, 404);
  return c.json({ status: 'queued', message: 'Job re-queued for retry' });
});

// Manually enqueue a new scrape job
jobRoutes.post('/jobs', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    job_type: ScrapeJobType;
    target: Record<string, unknown>;
    chitty_id?: string;
    max_attempts?: number;
  }>();

  if (!body.job_type || !body.target) {
    return c.json({ error: 'job_type and target are required' }, 400);
  }

  const validTypes: ScrapeJobType[] = ['court_docket', 'cook_county_tax', 'mr_cooper', 'portal_scrape'];
  if (!validTypes.includes(body.job_type)) {
    return c.json({ error: `Invalid job_type. Must be one of: ${validTypes.join(', ')}` }, 400);
  }

  const jobId = await enqueueJob(sql, body.job_type, body.target, {
    chittyId: body.chitty_id,
    maxAttempts: body.max_attempts,
    cronSource: 'manual',
  }, c.env);

  return c.json({ id: jobId, status: 'queued' }, 201);
});

// Trigger queue processing manually
jobRoutes.post('/jobs/queue/process', async (c) => {
  const sql = getDb(c.env);
  const result = await processQueue(sql, c.env);
  return c.json(result);
});
