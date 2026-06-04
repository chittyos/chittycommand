/**
 * Integration test for the real-dependency /health probe handler.
 *
 * Runs against a REAL Neon branch (no mocks — chittyentity CLAUDE.md
 * "No Mocks, Fake Data, or Placeholder Endpoints" rule).
 *
 * Usage:
 *   DATABASE_URL='postgres://...neon...' npx vitest run tests/health/health-probe.spec.ts
 *
 * Skipped automatically when DATABASE_URL is absent or SKIP_INTEGRATION=1 —
 * same pattern as tests/daemon/leader.spec.ts and tests/meta/intent-lifecycle.spec.ts.
 *
 * We import the probe handler directly from src/routes/health.ts (pure Node
 * compatible). Importing src/index.ts would drag in `cloudflare:` namespaced
 * modules (Agents SDK / Durable Objects) which only resolve under workerd.
 *
 * Verifies:
 *   1. probes.db.status === 'ok' against the real Neon branch with latency_ms > 0.
 *   2. probes.daemon.status ∈ { ok, stale, not_provisioned } — not over-asserted
 *      because the branch may or may not have cc_node_leases provisioned or
 *      an active node holding a lease.
 *   3. probes.chittyconnect.status is one of { ok, degraded, down }.
 *   4. httpStatus is 200 when db.status === 'ok'; 503 only when db is down.
 *   5. Response shape matches the documented spec.
 */

import { describe, it, expect } from 'vitest';
import { runHealthProbes } from '../../src/routes/health';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

describe.skipIf(SKIP)('/health real-dependency probe (real Neon)', () => {
  it('runs all probes and reports DB ok against the real Neon branch', async () => {
    const { body, httpStatus } = await runHealthProbes({
      DATABASE_URL,
      // CHITTYCONNECT_URL intentionally omitted: probe will report 'degraded'
      // with "not configured", which is the documented behavior.
    });

    // Spec: 200 unless db is down. DB is reachable on this branch.
    expect(httpStatus).toBe(200);

    expect(body.service).toBe('chittycommand');
    expect(typeof body.version).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    expect(['ok', 'degraded']).toContain(body.status);

    // DB probe must succeed.
    expect(body.probes.db.status).toBe('ok');
    expect(body.probes.db.latency_ms).toBeGreaterThan(0);

    // ChittyConnect probe shape — value depends on env, just assert shape.
    expect(['ok', 'degraded', 'down']).toContain(body.probes.chittyconnect.status);
    expect(typeof body.probes.chittyconnect.latency_ms).toBe('number');

    // Daemon probe — could be ok (active node), stale (no recent heartbeat),
    // or not_provisioned (table missing on this branch). Don't over-assert.
    expect(['ok', 'stale', 'not_provisioned']).toContain(body.probes.daemon.status);
  });

  it('marks status `down` and returns 503 when DB is unreachable', async () => {
    // Real connection-refused — no mock, just an invalid host that fails fast.
    const { body, httpStatus } = await runHealthProbes({
      DATABASE_URL:
        'postgresql://nobody:nobody@127.0.0.1:1/neondb?sslmode=disable',
    });

    expect(httpStatus).toBe(503);
    expect(body.status).toBe('down');
    expect(body.probes.db.status).toBe('down');
    expect(typeof body.probes.db.error).toBe('string');
  });
});
