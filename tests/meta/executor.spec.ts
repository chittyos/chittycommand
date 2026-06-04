/**
 * Integration test for meta/executors/dispatch.ts + meta/intent.ts::executeIntent.
 *
 * Covers (per ADR-001 amendment, PR-A):
 *   - executeIntent atomically claims a pending intent
 *   - dispatch() looks up the registered executor by intent_type
 *   - executor runs against real Neon (cc_obligations row updates)
 *   - cc_actions_log row appears with intent_id, attempt=1, idempotency_key set
 *   - second executeIntent call is idempotent (replays from audit row)
 *   - cc_intents.status moves to 'done'
 *
 * Real Neon only. Skipped without DATABASE_URL — same pattern as
 * tests/meta/intent-lifecycle.spec.ts (PR #101) and tests/daemon/leader.spec.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  createGoal,
  createPlan,
  createIntent,
  getIntent,
  executeIntent,
  type IntentEnv,
  type SovereigntyAssessmentSnapshot,
} from '../../meta/intent';
// Importing the executor barrel ensures registration side effects run.
import '../../meta/executors';
import { UPDATE_OBLIGATION_STATUS_INTENT } from '../../meta/executors/update-obligation-status';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv & Record<string, unknown> = { DATABASE_URL };
const OWNER = '01-A-NB-0001-P-66-1-1';
const TEST_TAG = `pra-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let obligationId: string | null = null;

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  // cc_actions_log rows referencing test intents will null out via ON DELETE
  // SET NULL when the intents cascade-delete from the goal teardown.
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
  if (obligationId) {
    await sql`DELETE FROM cc_actions_log WHERE target_id = ${obligationId}::uuid`;
    await sql`DELETE FROM cc_obligations WHERE id = ${obligationId}::uuid`;
  }
}

describe.skipIf(SKIP)('meta/executors — executeIntent round-trip', () => {
  beforeAll(async () => {
    await cleanup();
    const sql = neon(DATABASE_URL!);
    // Insert a real cc_obligations row for the executor to update.
    const rows = await sql`
      INSERT INTO cc_obligations (payee, category, due_date, status, metadata)
      VALUES (${TEST_TAG + '-payee'}, 'utilities', CURRENT_DATE + 7, 'pending', '{}'::jsonb)
      RETURNING id`;
    obligationId = String(rows[0].id);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('executes a pending intent, writes audit row, and is idempotent on replay', async () => {
    expect(obligationId).toBeTruthy();

    const goal = await createGoal(env, {
      ownerChittyId: OWNER,
      title: `${TEST_TAG}-goal`,
    });
    const plan = await createPlan(env, {
      goalId: goal.id,
      title: `${TEST_TAG}-plan`,
    });

    // Pre-seed a fresh sovereignty snapshot so dispatch() does NOT re-reckon
    // against trust.chitty.cc (advisor: freshness branch is the test's
    // positive path; stale-snapshot branch deferred).
    const sovereignty: SovereigntyAssessmentSnapshot = {
      decision: 'autonomous',
      trustScore: 0.95,
      reasoning: 'pre-seeded for integration test',
      assessedAt: new Date().toISOString(),
    };

    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: UPDATE_OBLIGATION_STATUS_INTENT,
      payload: {
        obligation_id: obligationId!,
        status: 'deferred',
        notes: TEST_TAG,
      },
      sovereigntyAssessment: sovereignty,
      metadata: { actorChittyId: OWNER },
    });

    expect(intent.status).toBe('pending');

    // First execution — real run.
    const first = await executeIntent(env, intent.id, { actorChittyId: OWNER });
    expect(first.ok).toBe(true);
    expect(first.replayed).toBeFalsy();
    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.actionLogId).toBeTruthy();

    // Verify cc_intents status moved to 'done'.
    const after = await getIntent(env, intent.id);
    expect(after?.status).toBe('done');

    // Verify exactly one cc_actions_log row with intent_id, attempt=1, key set.
    const sql = neon(DATABASE_URL!);
    const auditRows = (await sql`
      SELECT id, intent_id, attempt, idempotency_key, status, action_type
      FROM cc_actions_log
      WHERE intent_id = ${intent.id}::uuid
    `) as unknown as Array<{
      id: string;
      intent_id: string;
      attempt: number;
      idempotency_key: string;
      status: string;
      action_type: string;
    }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].attempt).toBe(1);
    expect(auditRows[0].idempotency_key).toBe(first.idempotencyKey);
    expect(auditRows[0].status).toBe('completed');
    expect(auditRows[0].action_type).toBe('status_change');

    // Verify the obligation actually moved to 'deferred'.
    const oblig = (await sql`
      SELECT status FROM cc_obligations WHERE id = ${obligationId}::uuid
    `) as unknown as Array<{ status: string }>;
    expect(oblig[0].status).toBe('deferred');

    // Second execution — must replay, not re-execute. attempt stays 1; no
    // new audit row appears.
    const second = await executeIntent(env, intent.id, { actorChittyId: OWNER });
    expect(second.replayed).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.actionLogId).toBe(first.actionLogId);

    const auditRowsAfter = (await sql`
      SELECT id FROM cc_actions_log WHERE intent_id = ${intent.id}::uuid
    `) as unknown as Array<{ id: string }>;
    expect(auditRowsAfter.length).toBe(1);
  });
});
