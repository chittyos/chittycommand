/**
 * Integration test for daemon/leader.ts session-ownership guards.
 *
 * Covers F2 (release) + F5 (heartbeat) — a process with the correct
 * nodeId but a different sessionId can NEITHER extend the lease NOR
 * release it. Defends against a restarted process accidentally
 * clobbering a newer leader.
 *
 * Real Neon. Skipped without DATABASE_URL — mirrors tests/daemon/leader.spec.ts.
 *
 * fixes codex-p2 PR#101 finding-2, finding-5
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  claimLeadership,
  heartbeat,
  releaseLeadership,
  describeLease,
  type LeaderEnv,
} from '../../daemon/leader';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const TEST_ROLE = `meta-orchestrator-leader-session-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const NODE = '01-A-MIN-0009-L-66-3-7';
const SESSION_OLD = `session-old-${Date.now()}`;
const SESSION_NEW = `session-new-${Date.now() + 1}`;

const env: LeaderEnv = { DATABASE_URL };

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_node_leases WHERE role = ${TEST_ROLE}`;
}

describe.skipIf(SKIP)('daemon/leader session ownership (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('a stale session cannot heartbeat after the lease was reclaimed by a new session (F5)', async () => {
    // Old process claims the lease.
    const oldLease = await claimLeadership(env, {
      nodeId: NODE,
      sessionId: SESSION_OLD,
      role: TEST_ROLE,
      leaseSeconds: 1, // expire fast so the new session can reclaim
    });
    expect(oldLease).not.toBeNull();
    expect(oldLease?.sessionId).toBe(SESSION_OLD);

    // Wait for the old lease to expire, then a NEW session of the SAME node reclaims.
    await new Promise((r) => setTimeout(r, 1100));
    const newLease = await claimLeadership(env, {
      nodeId: NODE,
      sessionId: SESSION_NEW,
      role: TEST_ROLE,
      leaseSeconds: 60,
    });
    expect(newLease).not.toBeNull();
    expect(newLease?.sessionId).toBe(SESSION_NEW);

    // The OLD session must NOT be able to heartbeat over the new lease.
    const stale = await heartbeat(env, NODE, {
      role: TEST_ROLE,
      leaseSeconds: 60,
      sessionId: SESSION_OLD,
    });
    expect(stale).toBeNull();

    // Confirm the lease is still owned by the new session.
    const current = await describeLease(env, { role: TEST_ROLE });
    expect(current?.sessionId).toBe(SESSION_NEW);

    // And the new session CAN heartbeat.
    const renewed = await heartbeat(env, NODE, {
      role: TEST_ROLE,
      leaseSeconds: 60,
      sessionId: SESSION_NEW,
    });
    expect(renewed).not.toBeNull();
    expect(renewed?.sessionId).toBe(SESSION_NEW);
  });

  it('a stale session cannot release a lease owned by a newer session (F2)', async () => {
    // The lease is still held by SESSION_NEW from the previous test.
    const before = await describeLease(env, { role: TEST_ROLE });
    expect(before?.sessionId).toBe(SESSION_NEW);

    // Old session tries to release — must be refused.
    const refused = await releaseLeadership(env, NODE, {
      role: TEST_ROLE,
      sessionId: SESSION_OLD,
    });
    expect(refused).toBe(false);

    // Lease is intact.
    const after = await describeLease(env, { role: TEST_ROLE });
    expect(after?.sessionId).toBe(SESSION_NEW);

    // Correct session releases successfully.
    const released = await releaseLeadership(env, NODE, {
      role: TEST_ROLE,
      sessionId: SESSION_NEW,
    });
    expect(released).toBe(true);

    const cleared = await describeLease(env, { role: TEST_ROLE });
    expect(cleared).toBeNull();
  });
});
