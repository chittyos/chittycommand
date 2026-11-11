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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const US_DATETIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}) ?(AM|PM)$/;

/** True when y-mo-d h:mi:s names a real calendar instant (no rollover). */
function validWall(y: number, mo: number, d: number, h = 0, mi = 0, sec = 0): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Cook County court inputs without an explicit offset are Chicago local time. */
export const COURT_DOCKET_TIME_ZONE = 'America/Chicago';
const DATE_ONLY_LOCAL_HOUR = 12;

const chicagoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: COURT_DOCKET_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Chicago's UTC offset in ms at instant `utcMs` (negative west of UTC). */
function chicagoOffsetMs(utcMs: number): number {
  const p: Record<string, number> = {};
  for (const part of chicagoParts.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Chicago wall-clock time as a UTC instant. Independent of the worker's own
 * time zone: the offset comes from Intl for America/Chicago, re-checked at
 * the candidate instant so DST boundaries resolve consistently.
 */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - chicagoOffsetMs(wall);
  const second = wall - chicagoOffsetMs(first);
  return second;
}

/**
 * Parse an ISO-8601 datetime that carries an explicit offset or Z. Returns
 * the ISO instant, or null for anything else (no free-text parsing).
 */
export function parseIsoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATETIME.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  if (!validWall(y, mo, d, h, mi, sec)) return null;
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000).toISOString();
}

/**
 * Strict docket date parser. Accepts only:
 *   YYYY-MM-DD, ISO datetime with offset/Z, M/D/YYYY, M/D/YYYY h:mm AM|PM.
 * Date-only values become 12:00 Chicago local; date+time values are Chicago
 * local; ISO datetimes with an offset/Z are taken as given.
 * Anything else (e.g. "Status 3", "Continued to 11") is null: the caller
 * skips and counts it. Free text never reaches a lenient engine parser.
 */
export function parseDocketDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;

  const iso = parseIsoInstant(v);
  if (iso) return iso;

  let m = ISO_DATE.exec(v);
  if (m) {
    const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
    return validWall(y, mo, d) ? new Date(wallToUtc(y, mo, d, DATE_ONLY_LOCAL_HOUR, 0)).toISOString() : null;
  }

  m = US_DATE.exec(v);
  if (m) {
    const [mo, d, y] = [m[1], m[2], m[3]].map(Number);
    return validWall(y, mo, d) ? new Date(wallToUtc(y, mo, d, DATE_ONLY_LOCAL_HOUR, 0)).toISOString() : null;
  }

  m = US_DATETIME.exec(v);
  if (m) {
    const [mo, d, y, h12, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
    if (h12 < 1 || h12 > 12) return null;
    const h = (h12 % 12) + (m[6] === 'PM' ? 12 : 0);
    return validWall(y, mo, d, h, mi) ? new Date(wallToUtc(y, mo, d, h, mi)).toISOString() : null;
  }

  return null;
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

  const scrapedAt = parseIsoInstant(result.scrapedAt);
  if (!scrapedAt || now.getTime() - new Date(scrapedAt).getTime() > maxAgeHours(env) * 3_600_000) {
    return { ok: false, caseNumber, error: 'stale_result', scrapedAt: result.scrapedAt };
  }
  const provenance = { source: 'chittyscrape', portal: result.portal ?? null, scrapedAt };

  let inserted = 0;
  let skippedUndated = 0;
  // Two entries with the same date and title in one push are distinct court
  // records. Number repeats 1..n in push order so both are kept and a re-run
  // of the same push maps each onto its existing row.
  const seen = new Map<string, number>();

  for (const entry of result.data?.entries ?? []) {
    const date = parseDocketDate(entry.date);
    if (!date) {
      skippedUndated++;
      continue;
    }
    const title = entry.description ? entry.description.slice(0, 500) : 'Docket entry';
    const key = `${date}\u0000${title}`;
    const entryOrdinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, entryOrdinal);
    const rows = await sql`
      INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata, entry_ordinal)
      VALUES (${caseNumber}, ${COURT_DOCKET_CASE_SYSTEM}, 'docket_entry', ${title}, ${entry.description ?? null}, ${date},
              ${JSON.stringify({ ...provenance, filedBy: entry.filedBy ?? null })}::jsonb, ${entryOrdinal})
      ON CONFLICT (case_ref, deadline_type, deadline_date, title, entry_ordinal) DO NOTHING
      RETURNING id
    `;
    inserted += rows.length;
  }

  if (result.data?.nextHearing !== undefined) {
    const hearingDate = parseDocketDate(result.data.nextHearing);
    if (!hearingDate) {
      skippedUndated++;
    } else {
      const rows = await sql`
        INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, description, deadline_date, metadata, entry_ordinal)
        VALUES (${caseNumber}, ${COURT_DOCKET_CASE_SYSTEM}, 'hearing', 'Next hearing', null, ${hearingDate},
                ${JSON.stringify(provenance)}::jsonb, 1)
        ON CONFLICT (case_ref, deadline_type, deadline_date, title, entry_ordinal) DO NOTHING
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
