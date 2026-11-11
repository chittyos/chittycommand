/**
 * Integration test for the court docket read-back (src/lib/court-docket.ts,
 * syncCourtDocket in src/lib/cron.ts, the /api/sync trigger that records its
 * status, and the /api/bridge/scrape/court-docket read-back route).
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
import { syncCourtDocketCase, CourtDocketSyncError } from '../../src/lib/court-docket';
import { syncCourtDocket } from '../../src/lib/cron';
import { syncRoutes } from '../../src/routes/sync';
import { scrapeRoutes } from '../../src/routes/bridge/scrape';

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
const CASE_REPEAT = `CCTEST-REP-${RUN}`;
const CASE_NOID = `CCTEST-NID-${RUN}`;
const CASE_FAILED = `CCTEST-ERR-${RUN}`;
const CASE_MULTI_A = `CCTEST-MLA-${RUN}`;
const CASE_MULTI_B = `CCTEST-MLB-${RUN}`;
const CASE_USDATE = `CCTEST-USD-${RUN}`;
const CASE_BR_MISSING = `CCTEST-B404-${RUN}`;
const CASE_BR_STALE = `CCTEST-B409-${RUN}`;
const CASE_BR_MISMATCH = `CCTEST-B502-${RUN}`;
const ALL_CASES = [
  CASE_INSERT, CASE_UNDATED, CASE_MISMATCH, CASE_MISSING, CASE_STALE,
  CASE_REPEAT, CASE_NOID, CASE_FAILED, CASE_MULTI_A, CASE_MULTI_B, CASE_USDATE,
  CASE_BR_MISSING, CASE_BR_STALE, CASE_BR_MISMATCH,
];

/** Stored results ChittyScrape would return, keyed by exact case string. */
const stored = new Map<string, unknown>();

function storedResult(caseId: string, data: Record<string, unknown>, scrapedAt = new Date().toISOString()) {
  return { success: true, data, error: null, method: 'scrape', portal: 'cook_county_circuit', caseId, scrapedAt };
}

function makeKv(values: Record<string, string>) {
  const map = new Map(Object.entries(values));
  return { get: async (key: string) => map.get(key) ?? null } as unknown as KVNamespace;
}

function makeEnv(trackedCases: string[] = [], { withToken = true } = {}): Env {
  return {
    DATABASE_URL,
    CHITTYSCRAPE_URL: SCRAPE_URL,
    COMMAND_KV: makeKv({
      ...(withToken ? { 'scrape:service_token': SCRAPE_TOKEN } : {}),
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

  async function readbackLogIds(): Promise<Set<string>> {
    const rows = await sql`SELECT id FROM cc_sync_log WHERE source = 'court_docket' AND sync_type = 'readback'`;
    return new Set(rows.map((r) => r.id as string));
  }

  /** POST the bridge read-back route; returns status, body, and the sync_log rows it created. */
  async function bridgeReadback(caseNumber: string) {
    const before = await readbackLogIds();
    const res = await scrapeRoutes.request(
      '/court-docket',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseNumber }) },
      makeEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    const created = [...await readbackLogIds()].filter((id) => !before.has(id));
    syncLogIds.push(...created);
    const logs = created.length > 0
      ? await sql`SELECT sync_type, status, error_message FROM cc_sync_log WHERE id = ANY(${created})`
      : [];
    return { status: res.status, body, logs };
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

    it('two identical same-day entries are two rows (ordinals 1, 2); a re-run inserts 0', async () => {
      const payload = storedResult(CASE_REPEAT, {
        caseNumber: CASE_REPEAT,
        entries: [
          { date: '2026-10-05', description: 'Order entered: continued for status' },
          { date: '2026-10-05', description: 'Order entered: continued for status' },
        ],
      });
      stored.set(CASE_REPEAT, payload);
      expect(await syncCourtDocketCase(makeEnv(), sql, CASE_REPEAT, SCRAPE_TOKEN)).toMatchObject({ ok: true, inserted: 2 });
      const rows = await sql`SELECT entry_ordinal FROM cc_legal_deadlines WHERE case_ref = ${CASE_REPEAT} ORDER BY entry_ordinal`;
      expect(rows.map((r) => r.entry_ordinal)).toEqual([1, 2]);

      stored.set(CASE_REPEAT, payload);
      expect(await syncCourtDocketCase(makeEnv(), sql, CASE_REPEAT, SCRAPE_TOKEN)).toMatchObject({ ok: true, inserted: 0 });
      expect(await rowsFor(CASE_REPEAT)).toHaveLength(2);
    });

    it('a result naming neither caseId nor data.caseNumber throws case_unverifiable and inserts nothing', async () => {
      stored.set(CASE_NOID, {
        success: true, error: null, method: 'scrape', portal: 'cook_county_circuit', scrapedAt: new Date().toISOString(),
        data: { entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }] },
      });
      await expect(syncCourtDocketCase(makeEnv(), sql, CASE_NOID, SCRAPE_TOKEN)).rejects.toMatchObject({ code: 'case_unverifiable' });
      expect(await rowsFor(CASE_NOID)).toHaveLength(0);
    });

    it('a stored result with success:false throws and inserts nothing', async () => {
      stored.set(CASE_FAILED, {
        ...storedResult(CASE_FAILED, {
          caseNumber: CASE_FAILED,
          entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }],
        }),
        success: false,
        error: 'portal_unavailable',
      });
      await expect(syncCourtDocketCase(makeEnv(), sql, CASE_FAILED, SCRAPE_TOKEN)).rejects.toThrow(/success=false/);
      expect(await rowsFor(CASE_FAILED)).toHaveLength(0);
    });

    it('syncCourtDocket throws when scrape:service_token is missing', async () => {
      await expect(syncCourtDocket(makeEnv([CASE_MULTI_B], { withToken: false }), sql)).rejects.toThrow(/scrape:service_token/);
      expect(await rowsFor(CASE_MULTI_B)).toHaveLength(0);
    });

    it('multi-case: a failed case does not stop the others, and the error carries failedCases and insertedTotal', async () => {
      // CASE_MULTI_A has nothing stored, so its fetch returns 404 no_submitted_result.
      stored.set(CASE_MULTI_B, storedResult(CASE_MULTI_B, {
        caseNumber: CASE_MULTI_B,
        entries: [
          { date: '2026-10-02', description: 'Motion to compel discovery filed' },
          { date: '2026-10-20', description: 'Order entered: briefing schedule set' },
        ],
      }));
      const err = await syncCourtDocket(makeEnv([CASE_MULTI_A, CASE_MULTI_B]), sql).then(
        () => { throw new Error('expected syncCourtDocket to throw'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CourtDocketSyncError);
      expect((err as CourtDocketSyncError).failedCases).toEqual([CASE_MULTI_A]);
      expect((err as CourtDocketSyncError).insertedTotal).toBe(2);
      expect(await rowsFor(CASE_MULTI_B)).toHaveLength(2);
      expect(await rowsFor(CASE_MULTI_A)).toHaveLength(0);
    });

    it('/api/sync trigger: one failed case among two records the inserted total and status error', async () => {
      // CASE_MULTI_A has nothing stored (404); CASE_MULTI_B returns two entries.
      stored.delete(CASE_MULTI_A);
      stored.set(CASE_MULTI_B, storedResult(CASE_MULTI_B, {
        caseNumber: CASE_MULTI_B,
        entries: [
          { date: '2026-10-02', description: 'Motion to compel discovery filed' },
          { date: '2026-10-20', description: 'Order entered: briefing schedule set' },
        ],
      }));
      const { body } = await triggerSync(makeEnv([CASE_MULTI_A, CASE_MULTI_B]));
      const [newest] = await sql`
        SELECT id, status, records_synced FROM cc_sync_log
        WHERE source = 'court_docket' ORDER BY started_at DESC LIMIT 1`;
      expect(newest.id).toBe(body.sync_id);
      expect(newest.records_synced).toBe(2);
      expect(newest.status).toBe('error');
    });

    it('bridge: absent result is 404 and logs one readback row', async () => {
      const { status, body, logs } = await bridgeReadback(CASE_BR_MISSING);
      expect(status).toBe(404);
      expect(body.error).toBe('no_submitted_result');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sync_type: 'readback', status: 'error' });
    });

    it('bridge: stale result is 409 and logs one readback row', async () => {
      stored.set(CASE_BR_STALE, storedResult(CASE_BR_STALE, {
        caseNumber: CASE_BR_STALE,
        entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }],
      }, new Date(Date.now() - 72 * 3_600_000).toISOString()));
      const { status, body, logs } = await bridgeReadback(CASE_BR_STALE);
      expect(status).toBe(409);
      expect(body.error).toBe('stale_result');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sync_type: 'readback', status: 'error' });
      expect(await rowsFor(CASE_BR_STALE)).toHaveLength(0);
    });

    it('bridge: case mismatch is 502 and logs one readback row', async () => {
      stored.set(CASE_BR_MISMATCH, storedResult(CASE_BR_MISMATCH, {
        caseNumber: `${CASE_BR_MISMATCH}-OTHER`,
        entries: [{ date: '2026-10-02', description: 'Motion to compel discovery filed' }],
      }));
      const { status, body, logs } = await bridgeReadback(CASE_BR_MISMATCH);
      expect(status).toBe(502);
      expect(body.error).toBe('court_docket_readback_failed');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sync_type: 'readback', status: 'error' });
      expect(logs[0].error_message).toContain('case mismatch');
      expect(await rowsFor(CASE_BR_MISMATCH)).toHaveLength(0);
    });

    it('a US-format date (10/02/2026) stored across two runs yields one row', async () => {
      const payload = () => storedResult(CASE_USDATE, {
        caseNumber: CASE_USDATE,
        entries: [{ date: '10/02/2026', description: 'Motion to compel discovery filed' }],
      });
      stored.set(CASE_USDATE, payload());
      expect(await syncCourtDocketCase(makeEnv(), sql, CASE_USDATE, SCRAPE_TOKEN)).toMatchObject({ ok: true, inserted: 1 });
      stored.set(CASE_USDATE, payload());
      expect(await syncCourtDocketCase(makeEnv(), sql, CASE_USDATE, SCRAPE_TOKEN)).toMatchObject({ ok: true, inserted: 0 });
      const rows = await rowsFor(CASE_USDATE);
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0].deadline_date as string).toISOString()).toBe('2026-10-02T17:00:00.000Z');
    });
  });
}
