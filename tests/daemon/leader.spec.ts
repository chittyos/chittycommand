/**
 * Integration test for daemon/leader.ts.
 *
 * Runs against a REAL Neon branch. No mocks — per the binding rule in
 * chittyentity CLAUDE.md "No Mocks, Fake Data, or Placeholder Endpoints".
 *
 * Usage:
 *   DATABASE_URL='postgres://...neon...' npx vitest run tests/daemon/leader.spec.ts
 *
 * Skipped automatically when DATABASE_URL is absent or SKIP_INTEGRATION=1, so
 * CI without a Neon branch URL doesn't fail. Set DATABASE_URL to the
 * meta-orchestrator-foundation branch connection string created via the Neon
 * MCP for this PR (see ADR-001 PR body).
 *
 * What this test verifies:
 *   1. A node can claim the lease on an empty role row.
 *   2. A concurrent claim from a different node (same role, lease still live)
 *      is rejected — atomicity guarantee.
 *   3. The original holder can heartbeat.
 *   4. After release, a previously-rejected node can claim.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  claimLeadership,
  heartbeat,
  releaseLeadership,
  describeLease,
  META_LEADER_ROLE,
  type LeaderEnv,
} from '../../daemon/leader';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

// Use a unique role per test run so concurrent CI runs don't collide and so
// we don't disturb any real meta-orchestrator-leader row.
const TEST_ROLE = `meta-orchestrator-leader-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Realistic ChittyOS-shaped IDs — Location type (L) for nodes.
const NODE_A = '01-A-MIN-0003-L-66-3-7'; // chittymini-03
const NODE_B = '01-A-MIN-0005-L-66-2-1'; // chittymini-05

const env: LeaderEnv = { DATABASE_URL };

async function cleanup(role: string) {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_node_leases WHERE role = ${role}`;
}

describe.skipIf(SKIP)('daemon/leader integration (real Neon)', () => {
  beforeAll(async () => {
    await cleanup(TEST_ROLE);
  });

  afterAll(async () => {
    await cleanup(TEST_ROLE);
  });

  it('first node claims an empty role row', async () => {
    const lease = await claimLeadership(env, {
      nodeId: NODE_A,
      nodeDescriptor: 'chittymini-03',
      sessionId: 'session-a-1',
      role: TEST_ROLE,
      leaseSeconds: 30,
    });
    expect(lease).not.toBeNull();
    expect(lease?.nodeId).toBe(NODE_A);
    expect(lease?.role).toBe(TEST_ROLE);
    expect(lease?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('concurrent claim from a different node while lease is live is rejected', async () => {
    const lease = await claimLeadership(env, {
      nodeId: NODE_B,
      nodeDescriptor: 'chittymini-05',
      sessionId: 'session-b-1',
      role: TEST_ROLE,
      leaseSeconds: 30,
    });
    expect(lease).toBeNull();

    // The lease still belongs to NODE_A.
    const current = await describeLease(env, { role: TEST_ROLE });
    expect(current?.nodeId).toBe(NODE_A);
  });

  it('the holder can heartbeat to extend the lease', async () => {
    const before = await describeLease(env, { role: TEST_ROLE });
    expect(before?.nodeId).toBe(NODE_A);
    // Give time so heartbeat advances measurably.
    await new Promise((r) => setTimeout(r, 50));
    const renewed = await heartbeat(env, NODE_A, { role: TEST_ROLE, leaseSeconds: 60 });
    expect(renewed).not.toBeNull();
    expect(renewed!.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before!.leaseExpiresAt.getTime(),
    );
  });

  it('a non-holder cannot heartbeat', async () => {
    const result = await heartbeat(env, NODE_B, { role: TEST_ROLE, leaseSeconds: 60 });
    expect(result).toBeNull();
  });

  it('after release, a previously-rejected node can claim', async () => {
    const released = await releaseLeadership(env, NODE_A, { role: TEST_ROLE });
    expect(released).toBe(true);

    const lease = await claimLeadership(env, {
      nodeId: NODE_B,
      nodeDescriptor: 'chittymini-05',
      sessionId: 'session-b-2',
      role: TEST_ROLE,
      leaseSeconds: 30,
    });
    expect(lease).not.toBeNull();
    expect(lease?.nodeId).toBe(NODE_B);
  });
});
