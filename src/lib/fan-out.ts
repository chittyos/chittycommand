import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { routerClient, ledgerClient } from './integrations';
import type { ScrapeJobType } from './job-dispatcher';

export interface ScrapeResultContext {
  jobId: string;
  jobType: ScrapeJobType;
  target: Record<string, unknown>;
  chittyId: string | null;
  result: Record<string, unknown>;
  recordsSynced: number;
}

/**
 * Fan out scrape results to downstream ChittyOS services.
 * All calls are fire-and-forget — failures are logged but don't affect the job.
 */
export async function fanOutScrapeResult(
  env: Env,
  sql: NeonQueryFunction<false, false>,
  ctx: ScrapeResultContext,
): Promise<void> {
  const results = await Promise.allSettled([
    fanOutToIntelligence(env, ctx),
    fanOutToCalendar(env, ctx),
    fanOutToTriage(env, ctx),
    fanOutToLedger(env, ctx),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[fan-out] downstream error:', r.reason);
    }
  }
}

/**
 * Send observations to ChittyRouter IntelligenceAgent.
 * Teaches the system about scrape patterns, portal changes, and data trends.
 */
async function fanOutToIntelligence(env: Env, ctx: ScrapeResultContext): Promise<void> {
  const router = routerClient(env);
  if (!router) return;

  try {
    await fetch(`${env.CHITTYROUTER_URL}/agents/intelligence/observe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Service': 'chittycommand',
      },
      body: JSON.stringify({
        observation_type: 'scrape_result',
        source_agent: 'chittycommand',
        org: 'personal',
        title: `${ctx.jobType} scrape completed`,
        description: `Job ${ctx.jobId}: ${ctx.recordsSynced} records synced`,
        severity: 'info',
        data: {
          jobId: ctx.jobId,
          jobType: ctx.jobType,
          target: ctx.target,
          recordCount: ctx.recordsSynced,
          timestamp: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[fan-out:intelligence]', err);
  }
}

/**
 * Extract deadlines from court/legal scrapes and push to CalendarAgent.
 */
async function fanOutToCalendar(env: Env, ctx: ScrapeResultContext): Promise<void> {
  if (ctx.jobType !== 'court_docket') return;
  if (!ctx.result.nextHearing && !ctx.result.entries) return;
  if (!env.CHITTYROUTER_URL) return;

  try {
    // Push next hearing as calendar event
    if (ctx.result.nextHearing) {
      await fetch(`${env.CHITTYROUTER_URL}/agents/calendar/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify({
          title: `Court Hearing: ${(ctx.target.case_number as string) || 'Unknown'}`,
          date: ctx.result.nextHearing,
          type: 'court_date',
          urgency: 'high',
          metadata: {
            source: 'scrape_fan_out',
            jobId: ctx.jobId,
            caseNumber: ctx.target.case_number,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
    }

    // Push docket entries with dates as calendar events
    const entries = ctx.result.entries as Array<Record<string, unknown>> | undefined;
    if (entries) {
      for (const entry of entries) {
        if (!entry.date) continue;
        await fetch(`${env.CHITTYROUTER_URL}/agents/calendar/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Source-Service': 'chittycommand',
          },
          body: JSON.stringify({
            title: `Docket: ${entry.description || entry.type || 'Entry'}`,
            date: entry.date,
            type: 'docket_entry',
            urgency: 'medium',
            metadata: {
              source: 'scrape_fan_out',
              jobId: ctx.jobId,
              caseNumber: ctx.target.case_number,
            },
          }),
          signal: AbortSignal.timeout(10000),
        });
      }
    }
  } catch (err) {
    console.error('[fan-out:calendar]', err);
  }
}

/**
 * Classify scrape findings via TriageAgent for urgency scoring.
 */
async function fanOutToTriage(env: Env, ctx: ScrapeResultContext): Promise<void> {
  // Only triage if there are new entries worth classifying
  const entries = ctx.result.entries as Array<Record<string, unknown>> | undefined;
  if (!entries || entries.length === 0) return;

  const router = routerClient(env);
  if (!router) return;

  try {
    await router.classifyDispute({
      entity_id: ctx.jobId,
      entity_type: 'dispute',
      title: `Scrape findings: ${ctx.jobType}`,
      dispute_type: ctx.jobType,
      description: `${entries.length} new entries from ${ctx.jobType} scrape`,
    });
  } catch (err) {
    console.error('[fan-out:triage]', err);
  }
}

/**
 * Record scrape event in ChittyLedger as an immutable audit entry.
 */
async function fanOutToLedger(env: Env, ctx: ScrapeResultContext): Promise<void> {
  if (!env.CHITTYLEDGER_URL) return;

  try {
    await fetch(`${env.CHITTYLEDGER_URL}/entries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Service': 'chittycommand',
      },
      // @canon: chittycanon://gov/governance#core-types
      // Ledger entityType is a record-category enum (not ChittyID P/L/T/E/A entity classification).
      // actorType: 'person' (P) for ChittyID-bound actors, 'service' for system actors.
      body: JSON.stringify({
        entityType: 'scrape',
        entityId: ctx.jobId,
        action: 'completed',
        actor: ctx.chittyId || 'chittycommand',
        actorType: ctx.chittyId ? 'person' : 'service',
        metadata: {
          jobType: ctx.jobType,
          target: ctx.target,
          recordsSynced: ctx.recordsSynced,
          completedAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[fan-out:ledger]', err);
  }
}
