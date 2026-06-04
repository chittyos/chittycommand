/**
 * Integration test for meta/intent.ts lifecycle guards.
 *
 * Covers:
 *   - F1 reclaimStuckIntents round-trip — stuck 'running' rows reset to
 *     'pending' with reclaim_count incremented and dispatched_task_id cleared.
 *   - F6 completeIntent / failIntent state guards — terminal states cannot
 *     be silently overwritten; idempotent re-calls are no-ops.
 *
 * Real Neon. Skipped without DATABASE_URL — mirrors tests/daemon/leader.spec.ts.
 *
 * fixes codex-p2 PR#101 finding-1, finding-6
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  createGoal,
  createPlan,
  createIntent,
  getIntent,
  completeIntent,
  failIntent,
  reclaimStuckIntents,
  type IntentEnv,
} from '../../meta/intent';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv = { DATABASE_URL };
const OWNER = '01-A-NB-0001-P-66-1-1';
const TEST_TAG = `codex-p2-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
}

describe.skipIf(SKIP)('meta/intent lifecycle (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('completeIntent only succeeds when status=running (F6)', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g1` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p1` });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { test: TEST_TAG },
    });

    // Brand new intent is 'pending' — completeIntent must NOT silently move it.
    const refusedFromPending = await completeIntent(env, intent.id);
    expect(refusedFromPending).toBeNull();
    const stillPending = await getIntent(env, intent.id);
    expect(stillPending?.status).toBe('pending');

    // Drive it to 'running' via raw SQL, then complete it — should succeed.
    const sql = neon(DATABASE_URL!);
    await sql`UPDATE cc_intents SET status = 'running' WHERE id = ${intent.id}`;
    const completed = await completeIntent(env, intent.id);
    expect(completed?.status).toBe('done');

    // Second call must be a no-op (idempotent guard).
    const repeat = await completeIntent(env, intent.id);
    expect(repeat).toBeNull();
  });

  it('failIntent cannot overwrite a terminal state (F6)', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g2` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p2` });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    await sql`UPDATE cc_intents SET status = 'done', completed_at = NOW() WHERE id = ${intent.id}`;
    const overwritten = await failIntent(env, intent.id, 'should be rejected');
    expect(overwritten).toBeNull();
    const final = await getIntent(env, intent.id);
    expect(final?.status).toBe('done');
  });

  it('reclaimStuckIntents resets stale running rows and bumps reclaim_count (F1)', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g3` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p3` });
    const fresh = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'fresh',
      payload: { test: TEST_TAG },
    });
    const stale = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'stale',
      payload: { test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    // Mark `stale` as running with an old updated_at.
    await sql`
      UPDATE cc_intents
      SET status = 'running',
          dispatched_task_id = 'task-to-be-cleared',
          updated_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${stale.id}`;
    // `fresh` is running but recent — must NOT be reclaimed.
    await sql`
      UPDATE cc_intents SET status = 'running', updated_at = NOW() WHERE id = ${fresh.id}`;

    const reclaimed = await reclaimStuckIntents(env, 60); // anything older than 60s
    expect(reclaimed).toBe(1);

    const staleAfter = await getIntent(env, stale.id);
    expect(staleAfter?.status).toBe('pending');
    expect(staleAfter?.dispatchedTaskId).toBeNull();
    expect(staleAfter?.errorMessage).toBeNull();

    const freshAfter = await getIntent(env, fresh.id);
    expect(freshAfter?.status).toBe('running');

    // reclaim_count should now be 1 for the reclaimed row.
    const rows = await sql`SELECT reclaim_count FROM cc_intents WHERE id = ${stale.id}`;
    expect(Number(rows[0].reclaim_count)).toBe(1);

    // Second call with the row already pending and recent — no-op (idempotent).
    const secondPass = await reclaimStuckIntents(env, 60);
    expect(secondPass).toBe(0);
  });

  // fixes codex-p2 PR#103 P1-B — stale executor's completion / failure must be
  // rejected when the dispatched_task_id no longer matches the in-flight one.
  it('completeIntent / failIntent reject stale execution tokens (P1-B)', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g4` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p4` });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'race',
      payload: { test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    // Simulate L2 currently running this intent under task token T2.
    await sql`
      UPDATE cc_intents
      SET status = 'running', dispatched_task_id = 'token-T2'
      WHERE id = ${intent.id}`;

    // L1's stale executor returns with its old token T1 and tries to complete.
    const staleComplete = await completeIntent(env, intent.id, 'token-T1');
    expect(staleComplete).toBeNull();
    const stillRunning = await getIntent(env, intent.id);
    expect(stillRunning?.status).toBe('running');
    expect(stillRunning?.dispatchedTaskId).toBe('token-T2');

    // L1's stale executor also can't fail T2's run.
    const staleFail = await failIntent(env, intent.id, 'stale error', 'token-T1');
    expect(staleFail).toBeNull();
    const stillRunning2 = await getIntent(env, intent.id);
    expect(stillRunning2?.status).toBe('running');

    // L2's real completion with the matching token succeeds.
    const liveComplete = await completeIntent(env, intent.id, 'token-T2');
    expect(liveComplete?.status).toBe('done');
  });
});
