import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { scrapeClient } from './integrations';

/**
 * Court docket read-back.
 *
 * ChittyScrape stores docket results that are pushed to it; this module reads
 * the latest stored result for one case and writes its dated entries into
 * cc_legal_deadlines. It never triggers a live scrape and never invents data:
 * an absent or stale result is an error the caller must surface, an entry with
 * no parseable date is skipped and counted, and a result for a different case
 * is refused outright.
 */

export const COURT_DOCKET_CASE_SYSTEM = 'cook_county';
const DEFAULT_MAX_AGE_HOURS = 48;

export type CourtDocketCaseResult =
  | { ok: true; caseNumber: string; inserted: number; skippedUndated: number; scrapedAt: string }
  | { ok: false; caseNumber: string; error: 'no_submitted_result' | 'stale_result'; scrapedAt?: string };

function maxAgeHours(env: Env): number {
  const parsed = Number(env.COURT_DOCKET_MAX_AGE_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Read the stored docket for one case and insert its entries.
 * Throws when ChittyScrape is unconfigured, the upstream errors, or the
 * result names a different case (nothing is inserted in that case).
 */
export async function syncCourtDocketCase(
  env: Env,
  sql: NeonQueryFunction<false, false>,
  caseNumber: string,
  token: string,
  now: Date = new Date(),
): Promise<CourtDocketCaseResult> {
  const scrape = scrapeClient(env);
  if (!scrape) throw new Error('ChittyScrape not configured (CHITTYSCRAPE_URL)');

  const result = await scrape.getLatestCourtDocket(caseNumber, token);
  if (!result) return { ok: false, caseNumber, error: 'no_submitted_result' };

  if (!result.success) {
    throw new Error(`[court_docket] ChittyScrape returned success=false for ${caseNumber}: ${result.error ?? 'no error given'}`);
  }

  const returnedCase = result.data?.caseNumber;
  if (returnedCase !== undefined && returnedCase !== caseNumber) {
    throw new Error(`[court_docket] case mismatch: requested ${caseNumber}, result is for ${returnedCase}`);
  }
  if (result.caseId !== undefined && result.caseId !== caseNumber) {
    throw new Error(`[court_docket] case mismatch: requested ${caseNumber}, result caseId is ${result.caseId}`);
  }

  const scrapedAtMs = result.scrapedAt ? Date.parse(result.scrapedAt) : NaN;
  if (Number.isNaN(scrapedAtMs) || now.getTime() - scrapedAtMs > maxAgeHours(env) * 3_600_000) {
    return { ok: false, caseNumber, error: 'stale_result', scrapedAt: result.scrapedAt };
  }
  const scrapedAt = new Date(scrapedAtMs).toISOString();
  const provenance = { source: 'chittyscrape', portal: result.portal ?? null, scrapedAt };

  let inserted = 0;
  let skippedUndated = 0;

  for (const entry of result.data?.entries ?? []) {
    const date = parseDate(entry.date);
    if (!date) {
      skippedUndated++;
      continue;
    }
    const title = entry.description ? entry.description.slice(0, 500) : 'Docket entry';
    const rows = await sql`
      INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata)
      VALUES (${caseNumber}, ${COURT_DOCKET_CASE_SYSTEM}, 'docket_entry', ${title}, ${entry.description ?? null}, ${date},
              ${JSON.stringify({ ...provenance, filedBy: entry.filedBy ?? null })}::jsonb)
      ON CONFLICT (case_ref, deadline_type, deadline_date, title) DO NOTHING
      RETURNING id
    `;
    inserted += rows.length;
  }

  if (result.data?.nextHearing !== undefined) {
    const hearingDate = parseDate(result.data.nextHearing);
    if (!hearingDate) {
      skippedUndated++;
    } else {
      const rows = await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata)
        VALUES (${caseNumber}, ${COURT_DOCKET_CASE_SYSTEM}, 'hearing', 'Next hearing', null, ${hearingDate},
                ${JSON.stringify(provenance)}::jsonb)
        ON CONFLICT (case_ref, deadline_type, deadline_date, title) DO NOTHING
        RETURNING id
      `;
      inserted += rows.length;
    }
  }

  if (skippedUndated > 0) {
    console.warn(`[court_docket] ${caseNumber}: skipped ${skippedUndated} undated entr${skippedUndated === 1 ? 'y' : 'ies'}`);
  }

  return { ok: true, caseNumber, inserted, skippedUndated, scrapedAt };
}
