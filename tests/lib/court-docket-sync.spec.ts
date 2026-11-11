/**
 * Integration test for the court docket read-back (src/lib/court-docket.ts,
 * syncCourtDocket in src/lib/cron.ts, and the /api/sync trigger that records
 * its status).
 *
 * Runs against a REAL Neon branch. The database is never mocked. The only
 * test double is the HTTP fetch to ChittyScrape, an external service: the
 * stub serves stored docket results in the upstream contract shape
 * (chittyscrape #24) and passes every other request (the Neon HTTP driver's)
 * through to the real fetch. COMMAND_KV is an in-memory Map: there is no KV
 * binding outside workerd, and it holds only config (token, tracked cases).
 *
 * Usage:
 *   DATABASE_URL='postgres://...neon...' npx vitest run tests/lib/court-docket-sync.spec.ts
 *
 * Skipped when DATABASE_URL is absent or SKIP_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { neon } from '@neondatabase/serverless';
import type { Env } from '../../src/index';
import { syncCourtDocketCase } from '../../src/lib/court-docket';
import { syncRoutes } from '../../src/routes/sync';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';
const SKIP_MESSAGE =
  'court-docket-sync: SKIPPED — DATABASE_URL is unset (or SKIP_INTEGRATION=1); this spec runs only against a real Neon branch';

const SCRAPE_URL = 'https://scrape.chitty.cc';
const SCRAPE_TOKEN = 'court-docket-sync-spec-token';
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CASE_INSERT = `CCTEST-INS-${RUN}`;
const CASE_UNDATED = `CCTEST-UND-${RUN}`;
const CASE_MISMATCH = `CCTEST-MIS-${RUN}`;
const CASE_MISSING = `CCTEST-404-${RUN}`;
const CASE_STALE = `CCTEST-OLD-${RUN}`;
const ALL_CASES = [CASE_INSERT, CASE_UNDATED, CASE_MISMATCH, CASE_MISSING, CASE_STALE];

/** Stored results ChittyScrape would return, keyed by exact case string. */
const stored = new Map<string, unknown>();

function storedResult(caseId: string, data: Record<string, unknown>, scrapedAt = new Date().toISOString()) {
  return { success: true, data, error: null, method: 'scrape', portal: 'cook_county_circuit', caseId, scrapedAt };
}

function makeKv(values: Record<string, string>) {
  const map = new Map(Object.entries(values));
  return { get: async (key: string) => map.get(key) ?? null } as unknown as KVNamespace;
}

function makeEnv(trackedCases: string[] = []): Env {
  return {
    DATABASE_URL,
    CHITTYSCRAPE_URL: SCRAPE_URL,
    COMMAND_KV: makeKv({
      'scrape:service_token': SCRAPE_TOKEN,
      'legal:tracked_cases': JSON.stringify(trackedCases),
    }),
  } as unknown as Env;
}

if (SKIP) {
  console.log(SKIP_MESSAGE);
  describe('court docket read-back (real Neon)', () => {
    it.skip(SKIP_MESSAGE, () => {});
  });
} else {
  const sql = neon(DATABASE_URL!);
  const realFetch = globalThis.fetch;
  const syncLogIds: string[] = [];

  async function rowsFor(caseRef: string) {
    return sql`
      SELECT case_ref, case_system, deadline_type, title, description, deadline_date, metadata
      FROM cc_legal_deadlines WHERE case_ref = ${caseRef}
      ORDER BY deadline_date, title
    `;
  }

  async function cleanup() {
    await sql`DELETE FROM cc_legal_deadlines WHERE case_ref = ANY(${ALL_CASES})`;
    if (syncLogIds.length > 0) await sql`DELETE FROM cc_sync_log WHERE id = ANY(${syncLogIds})`;
  }

  async function triggerSync(env: Env) {
    // An execution context without waitUntil makes the route run inline.
    const res = await syncRoutes.request('/trigger/court_docket', { method: 'POST' }, env, {} as ExecutionContext);
    const body = await res.json() as { sync_id: string; status: string; error_message: string | null };
    syncLogIds.push(body.sync_id);
    const [log] = await sql`SELECT status, error_message FROM cc_sync_log WHERE id = ${body.sync_id}`;
    return { body, log };
  }

  describe('court docket read-back (real Neon)', () => {
    beforeAll(async () => {
      await cleanup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.origin !== SCRAPE_URL) return realFetch(input, init);
        expect(url.pathname).toBe('/api/scrape/court-docket/latest');
        const body = stored.get(url.searchParams.get('case') ?? '');
        if (!body) {
          return new Response(JSON.stringify({ success: false, error: 'no_submitted_result' }), { status: 404 });
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    });

    afterEach(() => {
      stored.clear();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await cleanup();
    });

    it('inserts a pushed payload into the real cc_legal_deadlines columns', async () => {
      const scrapedAt = new Date().toISOString();
      stored.set(CASE_INSERT, storedResult(CASE_INSERT, {
        caseNumber: CASE_INSERT,
        entries: [
          { date: '2026-10-02', description: 'Motion to compel discovery filed', filedBy: 'Petitioner' },
          { date: '2026-10-20', description: 'Order entered: briefing schedule set' },
        ],
        nextHearing: '2026-12-03T14:30:00Z',
      }, scrapedAt));

      const result = await syncCourtDocketCase(makeEnv(), sql, CASE_INSERT, SCRAPE_TOKEN);
      expect(result).toMatchObject({ ok: true, inserted: 3, skippedUndated: 0 });

      const rows = await rowsFor(CASE_INSERT);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.case_system === 'cook_county')).toBe(true);
      expect(rows[0]).toMatchObject({
        case_ref: CASE_INSERT,
        deadline_type: 'docket_entry',
        title: 'Motion to compel discovery filed',
        description: 'Motion to compel discovery filed',
      });
      // Date-only docket dates are stored as 12:00 America/Chicago (CDT on this date).
      expect(new Date(rows[0].deadline_date as string).toISOString()).toBe('2026-10-02T17:00:00.000Z');
      expect(rows[0].metadata).toMatchObject({ source: 'chittyscrape', filedBy: 'Petitioner', scrapedAt });
      expect(rows[2]).toMatchObject({ deadline_type: 'hearing', title: 'Next hearing' });
      expect(new Date(rows[2].deadline_date as string).toISOString()).toBe('2026-12-03T14:30:00.000Z');
    });

    it('a second run over the same payload inserts zero new rows', async () => {
      stored.set(CASE_INSERT, storedResult(CASE_INSERT, {
        caseNumber: CASE_INSERT,
        entries: [
          { date: '2026-10-02', description: 'Motion to compel discovery filed', filedBy: 'Petitioner' },
          { date: '2026-10-20', description: 'Order entered: briefing schedule set' },
        ],
        nextHearing: '2026-12-03T14:30:00Z',
      }));

      const result = await syncCourtDocketCase(makeEnv(), sql, CASE_INSERT, SCRAPE_TOKEN);
      expect(result).toMatchObject({ ok: true, inserted: 0 });
      expect(await rowsFor(CASE_INSERT)).toHaveLength(3);
    });

    it('skips and counts entries with no parseable date', async () => {
      stored.set(CASE_UNDATED, storedResult(CASE_UNDATED, {
        caseNumber: CASE_UNDATED,
        entries: [
          { description: 'Appearance filed' },
          { date: '', description: 'Notice of motion' },
          { date: 'continued generally', description: 'Status call' },
          { date: '2026-11-04', description: 'Case management order entered' },
        ],
      }));

      const result = await syncCourtDocketCase(makeEnv(), sql, CASE_UNDATED, SCRAPE_TOKEN);
      expect(result).toMatchObject({ ok: true, inserted: 1, skippedUndated: 3 });
      const rows = await rowsFor(CASE_UNDATED);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Case management order entered');
    });

    it('a result for a different case throws and inserts nothing', async () => {
      stored.set(CASE_MISMATCH, storedResult(CASE_MISMATCH, {
        caseNumber: `${CASE_MISMATCH}-OTHER`,
        entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }],
      }));

      await expect(syncCourtDocketCase(makeEnv(), sql, CASE_MISMATCH, SCRAPE_TOKEN)).rejects.toThrow(/case mismatch/);
      expect(await rowsFor(CASE_MISMATCH)).toHaveLength(0);
    });

    it('no submitted result (404) records sync status error, not completed', async () => {
      const { body, log } = await triggerSync(makeEnv([CASE_MISSING]));
      expect(body.status).toBe('error');
      expect(log.status).toBe('error');
      expect(log.error_message).toContain(`${CASE_MISSING}: no_submitted_result`);
      expect(await rowsFor(CASE_MISSING)).toHaveLength(0);
    });

    it('a result older than the max age records sync status error with scrapedAt', async () => {
      const scrapedAt = new Date(Date.now() - 72 * 3_600_000).toISOString();
      stored.set(CASE_STALE, storedResult(CASE_STALE, {
        caseNumber: CASE_STALE,
        entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }],
      }, scrapedAt));

      const { body, log } = await triggerSync(makeEnv([CASE_STALE]));
      expect(body.status).toBe('error');
      expect(log.status).toBe('error');
      expect(log.error_message).toContain(`${CASE_STALE}: stale_result (scrapedAt ${scrapedAt})`);
      expect(await rowsFor(CASE_STALE)).toHaveLength(0);
    });
  });
}
