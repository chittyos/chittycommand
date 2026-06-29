/**
 * Integration tests for /api/vendors (vendor spend control).
 *
 * Real Neon. Skipped without DATABASE_URL — mirrors the established pattern in
 * tests/routes/triage-roux.spec.ts (no-mocks rule per CLAUDE.md). The cc_vendors
 * table is created by the vitest globalSetup (migration 0019 is registered in
 * ADDITIVE_PREFIXES).
 *
 * Regression coverage for the two Codex findings on PR #119:
 *   - PATCH must persist `metadata` (it was accepted but never written).
 *   - at_risk filtering uses live recompute, not the stored risk_score.
 * Plus the documented FULL-representation upsert semantics of POST.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import { Hono } from 'hono';
import type { Env } from '../../src/index';
import { vendorRoutes } from '../../src/routes/vendors';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';
const TAG = `vtest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const env = { DATABASE_URL } as unknown as Env;

const app = new Hono<{ Bindings: Env }>();
app.route('/api/vendors', vendorRoutes);

async function api(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost/api/vendors${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await app.fetch(req, env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_vendors WHERE vendor_name LIKE ${TAG + '%'}`;
}

describe.skipIf(SKIP)('/api/vendors (real Neon)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('POST creates a vendor and computes a risk score', async () => {
    const { status, json } = await api('POST', '/', {
      vendor_name: `${TAG}-create`,
      category: 'infra',
      billing_cycle: 'monthly',
      expected_amount: 25,
      payment_status: 'active',
      auto_pay: true,
    });
    expect(status).toBe(201);
    expect(json.id).toBeTruthy();
    expect(typeof json.risk_score).toBe('number');
  });

  it('PATCH persists metadata (regression: was accepted but never written)', async () => {
    const created = await api('POST', '/', { vendor_name: `${TAG}-meta`, category: 'data' });
    expect(created.status).toBe(201);
    const id = created.json.id;

    const patched = await api('PATCH', `/${id}`, { metadata: { owner_note: 'hello', team: 'ops' } });
    expect(patched.status).toBe(200);

    const got = await api('GET', `/${id}`);
    expect(got.status).toBe(200);
    expect(got.json.metadata).toMatchObject({ owner_note: 'hello', team: 'ops' });
  });

  it('GET ?at_risk=true filters by live risk (failed in, healthy out)', async () => {
    await api('POST', '/', {
      vendor_name: `${TAG}-failed`,
      category: 'ai_inference',
      payment_status: 'failed', // → risk 50 (at risk)
    });
    await api('POST', '/', {
      vendor_name: `${TAG}-healthy`,
      category: 'dev_tooling',
      payment_status: 'active',
      auto_pay: true, // → risk 0 (not at risk)
    });

    const { status, json } = await api('GET', '/?at_risk=true');
    expect(status).toBe(200);
    const names: string[] = json.vendors.map((v: { vendor_name: string }) => v.vendor_name);
    expect(names).toContain(`${TAG}-failed`);
    expect(names).not.toContain(`${TAG}-healthy`);
  });

  it('POST is a FULL upsert: a partial re-POST clobbers omitted fields to defaults', async () => {
    const name = `${TAG}-upsert`;
    const first = await api('POST', '/', {
      vendor_name: name,
      category: 'infra',
      payment_status: 'failed',
      mtd_spend: 200,
    });
    expect(first.status).toBe(201);
    expect(parseFloat(first.json.mtd_spend)).toBe(200);

    // Re-POST with only name+category — documented behaviour resets the rest.
    const second = await api('POST', '/', { vendor_name: name, category: 'data' });
    expect(second.status).toBe(201);
    expect(second.json.category).toBe('data');
    expect(parseFloat(second.json.mtd_spend)).toBe(0); // clobbered to default
    expect(second.json.payment_status).toBe('unknown'); // clobbered to default
  });

  it('GET /summary returns spend rollups', async () => {
    const { status, json } = await api('GET', '/summary');
    expect(status).toBe(200);
    expect(typeof json.total_mtd_spend).toBe('number');
    expect(json.by_level).toHaveProperty('critical');
    expect(Array.isArray(json.at_risk)).toBe(true);
    expect(Array.isArray(json.upcoming_bills)).toBe(true);
  });
});
