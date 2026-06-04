/**
 * Integration test for daemon/loop.ts wired end-to-end through executeIntent.
 *
 * Covers (per stacked PR on #106):
 *   - runLeaderLoop acquires leadership against real cc_node_leases
 *   - Two seeded pending intents (real Goals / Plans / Obligations) are claimed
 *     and dispatched via executeIntent → dispatch → update_obligation_status
 *   - Each intent produces exactly one cc_actions_log row with intent_id set,
 *     attempt=1, idempotency_key set, action_type='status_change',
 *     status='completed'
 *   - cc_obligations rows actually move to the target status
 *   - cc_intents move to status='done'
 *   - cc_node_leases shows the leader released its hold on clean exit
 *
 * Real Neon only. Skipped without DATABASE_URL — same pattern as
 * tests/meta/intent-lifecycle.spec.ts and tests/meta/executor.spec.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import { runLeaderLoop } from '../../daemon/loop';
import {
  createGoal,
  createPlan,
  createIntent,
  getIntent,
  type IntentEnv,
  type SovereigntyAssessmentSnapshot,
} from '../../meta/intent';
import { META_LEADER_ROLE } from '../../daemon/leader';
// Importing the executor barrel ensures registration side effects run.
import '../../meta/executors';
import { UPDATE_OBLIGATION_STATUS_INTENT } from '../../meta/executors/update-obligation-status';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv & Record<string, unknown> = { DATABASE_URL };
const OWNER = '01-A-NB-0001-P-66-1-1';
// Use a Location-typed ChittyID for the node, per canon (L = Location).
const NODE_ID = '01-A-NB-T01-L-66-1-1';
const TEST_TAG = `loop-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const obligationIds: string[] = [];

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
  for (const id of obligationIds) {
    await sql`DELETE FROM cc_actions_log WHERE target_id = ${id}::uuid`;
    await sql`DELETE FROM cc_obligations WHERE id = ${id}::uuid`;
  }
  // Release any lease this test left behind so re-runs are clean.
  await sql`
    UPDATE cc_node_leases
    SET node_id = NULL, node_descriptor = NULL, session_id = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL
    WHERE node_id = ${NODE_ID}`;
}

describe.skipIf(SKIP)('daemon/loop — end-to-end through executeIntent (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
    const sql = neon(DATABASE_URL!);
    // Insert two real cc_obligations rows for the executor to update.
    for (let i = 0; i < 2; i++) {
      const rows = await sql`
        INSERT INTO cc_obligations (payee, category, due_date, status, metadata)
        VALUES (${TEST_TAG + '-payee-' + i}, 'utilities', CURRENT_DATE + 7, 'pending', '{}'::jsonb)
        RETURNING id`;
      obligationIds.push(String(rows[0].id));
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it('drains two pending intents, writes audit rows, heartbeats, releases on clean exit', async () => {
    expect(obligationIds).toHaveLength(2);

    const goal = await createGoal(env, {
      ownerChittyId: OWNER,
      title: `${TEST_TAG}-goal`,
    });
    const plan = await createPlan(env, {
      goalId: goal.id,
      title: `${TEST_TAG}-plan`,
    });

    // Pre-seed fresh sovereignty so dispatch() takes the autonomous path
    // without calling out to trust.chitty.cc.
    const sovereignty: SovereigntyAssessmentSnapshot = {
      decision: 'autonomous',
      trustScore: 0.95,
      reasoning: 'pre-seeded for daemon loop integration test',
      assessedAt: new Date().toISOString(),
    };

    const intentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const intent = await createIntent(env, {
        planId: plan.id,
        goalId: goal.id,
        intentType: UPDATE_OBLIGATION_STATUS_INTENT,
        payload: {
          obligation_id: obligationIds[i],
          status: 'deferred',
          notes: `${TEST_TAG}-intent-${i}`,
        },
        sovereigntyAssessment: sovereignty,
        metadata: { actorChittyId: OWNER },
        priority: i, // lower number first
      });
      expect(intent.status).toBe('pending');
      intentIds.push(intent.id);
    }

    // Drive the loop until both intents reach terminal status or we hit the
    // bounded iteration cap. maxIntents=2 lets the loop exit cleanly after
    // both are processed; maxIterations provides a hard safety net.
    const logLines: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const sessionId = `${process.pid}@${Date.now()}-test`;

    const result = await runLeaderLoop(env, {
      nodeId: NODE_ID,
      nodeDescriptor: 'integration-test',
      sessionId,
      leaseSeconds: 30,
      heartbeatMs: 1_000,
      parkMs: 250,
      maxIntents: 2,
      maxIterations: 50,
      signal: controller.signal,
      actorChittyId: OWNER,
      log: (msg, meta) => logLines.push({ msg, meta }),
    });

    expect(result.reason).toBe('maxIntents');
    expect(result.intentsProcessed).toBe(2);
    expect(result.intentsErrored).toBe(0);
    expect(result.intentsRefused).toBe(0);

    // Both intents should be terminal=done.
    for (const id of intentIds) {
      const after = await getIntent(env, id);
      expect(after?.status).toBe('done');
    }

    // Each intent produced exactly one cc_actions_log row.
    const sql = neon(DATABASE_URL!);
    for (const id of intentIds) {
      const rows = (await sql`
        SELECT id, intent_id, attempt, idempotency_key, status, action_type
        FROM cc_actions_log
        WHERE intent_id = ${id}::uuid
      `) as unknown as Array<{
        id: string;
        intent_id: string;
        attempt: number;
        idempotency_key: string;
        status: string;
        action_type: string;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].attempt).toBe(1);
      expect(rows[0].idempotency_key).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].action_type).toBe('status_change');
    }

    // Obligations actually moved to 'deferred'.
    for (const id of obligationIds) {
      const rows = (await sql`
        SELECT status FROM cc_obligations WHERE id = ${id}::uuid
      `) as unknown as Array<{ status: string }>;
      expect(rows[0].status).toBe('deferred');
    }

    // cc_node_leases shows leadership was released on clean exit (maxIntents
    // path -> releaseLeadership). The row persists with node_id=NULL.
    const leaseRows = (await sql`
      SELECT node_id, session_id, heartbeat_at
      FROM cc_node_leases WHERE role = ${META_LEADER_ROLE}
    `) as unknown as Array<{
      node_id: string | null;
      session_id: string | null;
      heartbeat_at: string | null;
    }>;
    expect(leaseRows.length).toBeGreaterThan(0);
    expect(leaseRows[0].node_id).toBeNull();
    expect(leaseRows[0].session_id).toBeNull();

    // Log evidence of heartbeat activity bracketing each intent.
    const heartbeatBefore = logLines.filter((l) => l.msg === 'intent_heartbeat_before').length;
    const heartbeatAfter = logLines.filter((l) => l.msg === 'intent_heartbeat_after').length;
    expect(heartbeatBefore).toBe(2);
    expect(heartbeatAfter).toBe(2);
    const leaderAcquired = logLines.filter((l) => l.msg === 'leader_acquired').length;
    expect(leaderAcquired).toBeGreaterThanOrEqual(1);

    // Sanity: abort the controller — no-op for this run (already returned),
    // but proves the wiring compiles.
    controller.abort();
  }, 60_000);
});
