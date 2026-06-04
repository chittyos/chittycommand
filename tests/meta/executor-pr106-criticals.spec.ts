/**
 * PR #106 critical-bug regression tests.
 *
 *   FIX 1 — Replay short-circuit must match (intent_id, idempotency_key),
 *           not intent_id alone. A pre-existing terminal row for an OLD
 *           attempt's key must NOT short-circuit a new attempt whose
 *           computed key differs.
 *
 *   FIX 2 — On a sovereignty refusal, dispatch writes the audit row and
 *           calls failIntent itself. It must return `replayed: true` so
 *           executeIntent's `!result.replayed` guard skips its own
 *           failIntent — yielding exactly ONE failIntent invocation
 *           (visible as a single status row in cc_intent_status_history,
 *           or by SQL-level counting of NULL→failed transitions).
 *
 * Real Neon only — skipped without DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  createGoal,
  createPlan,
  createIntent,
  executeIntent,
  type IntentEnv,
  type SovereigntyAssessmentSnapshot,
} from '../../meta/intent';
import '../../meta/executors';
import { UPDATE_OBLIGATION_STATUS_INTENT } from '../../meta/executors/update-obligation-status';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv & Record<string, unknown> = { DATABASE_URL };
const OWNER = '01-A-NB-0001-P-66-1-2';
const TEST_TAG = `pr106-crit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const created: { goalIds: string[]; obligationIds: string[] } = {
  goalIds: [],
  obligationIds: [],
};

async function freshSovereignty(): Promise<SovereigntyAssessmentSnapshot> {
  return {
    decision: 'autonomous',
    trustScore: 0.95,
    reasoning: 'pre-seeded for PR #106 critical regression',
    assessedAt: new Date().toISOString(),
  };
}

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
  for (const oid of created.obligationIds) {
    await sql`DELETE FROM cc_actions_log WHERE target_id = ${oid}::uuid`;
    await sql`DELETE FROM cc_obligations WHERE id = ${oid}::uuid`;
  }
}

describe.skipIf(SKIP)('PR #106 criticals — replay-by-key + single failIntent', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('FIX 1: a prior terminal row with a DIFFERENT key does NOT short-circuit a new attempt', async () => {
    const sql = neon(DATABASE_URL!);

    // Seed a real obligation for the executor to update.
    const oblRows = await sql`
      INSERT INTO cc_obligations (payee, category, due_date, status, metadata)
      VALUES (${TEST_TAG + '-fix1-payee'}, 'utilities', CURRENT_DATE + 7, 'pending', '{}'::jsonb)
      RETURNING id`;
    const obligationId = String(oblRows[0].id);
    created.obligationIds.push(obligationId);

    const goal = await createGoal(env, {
      ownerChittyId: OWNER,
      title: `${TEST_TAG}-fix1-goal`,
    });
    created.goalIds.push(goal.id);
    const plan = await createPlan(env, {
      goalId: goal.id,
      title: `${TEST_TAG}-fix1-plan`,
    });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: UPDATE_OBLIGATION_STATUS_INTENT,
      payload: { obligation_id: obligationId, status: 'paid', notes: TEST_TAG },
      sovereigntyAssessment: await freshSovereignty(),
      metadata: { actorChittyId: OWNER },
    });

    // Hand-insert a terminal cc_actions_log row for this intent with a key
    // that we know will NOT match the key dispatch() will compute for
    // attempt=1 (sha256("{id}:1:{type}")). Use a sentinel hex string.
    const bogusKey = 'a'.repeat(64);
    await sql`
      INSERT INTO cc_actions_log
        (intent_id, attempt, idempotency_key, action_type, target_type, target_id,
         description, status, error_message, request_payload, response_payload, metadata)
      VALUES
        (${intent.id}::uuid, 0, ${bogusKey}, 'status_change', 'obligation',
         ${obligationId}::uuid, 'pre-existing terminal row from a different key',
         'completed', NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;

    // Now execute. Pre-fix behavior: replay short-circuit fires on the bogus
    // row, executor never runs, obligation stays 'pending'.
    // Post-fix: key mismatch → executor runs → obligation becomes 'paid'.
    const result = await executeIntent(env, intent.id, { actorChittyId: OWNER });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBeFalsy();
    expect(result.idempotencyKey).not.toBe(bogusKey);

    const oblStatus = (await sql`
      SELECT status FROM cc_obligations WHERE id = ${obligationId}::uuid
    `) as unknown as Array<{ status: string }>;
    expect(oblStatus[0].status).toBe('paid');

    // Two rows now: the bogus seed (attempt=0) + the real run (attempt=1).
    const auditRows = (await sql`
      SELECT attempt, idempotency_key FROM cc_actions_log
      WHERE intent_id = ${intent.id}::uuid ORDER BY attempt ASC
    `) as unknown as Array<{ attempt: number; idempotency_key: string }>;
    expect(auditRows.length).toBe(2);
    expect(auditRows[0].attempt).toBe(0);
    expect(auditRows[0].idempotency_key).toBe(bogusKey);
    expect(auditRows[1].attempt).toBe(1);
    expect(auditRows[1].idempotency_key).toBe(result.idempotencyKey);
  });

  it('FIX 2: a sovereignty refusal results in exactly ONE failIntent transition', async () => {
    const sql = neon(DATABASE_URL!);

    const goal = await createGoal(env, {
      ownerChittyId: OWNER,
      title: `${TEST_TAG}-fix2-goal`,
    });
    created.goalIds.push(goal.id);
    const plan = await createPlan(env, {
      goalId: goal.id,
      title: `${TEST_TAG}-fix2-plan`,
    });

    // Seed an obligation we can target (executor never runs on the refusal
    // path, but createIntent's payload still needs a valid shape).
    const oblRows = await sql`
      INSERT INTO cc_obligations (payee, category, due_date, status, metadata)
      VALUES (${TEST_TAG + '-fix2-payee'}, 'utilities', CURRENT_DATE + 7, 'pending', '{}'::jsonb)
      RETURNING id`;
    const obligationId = String(oblRows[0].id);
    created.obligationIds.push(obligationId);

    // STALE snapshot forces dispatch to re-reckon sovereignty. We point
    // CHITTYTRUST_URL at a non-routable address so assessSovereignty's
    // catch branch returns decision='blocked' (real network failure — no
    // mock, just a real DNS hole). Refusal path triggers.
    const stale: SovereigntyAssessmentSnapshot = {
      decision: 'autonomous',
      trustScore: 0.95,
      reasoning: 'pre-seeded stale',
      assessedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString(),
    };

    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: UPDATE_OBLIGATION_STATUS_INTENT,
      payload: { obligation_id: obligationId, status: 'paid', notes: TEST_TAG },
      sovereigntyAssessment: stale,
      metadata: { actorChittyId: OWNER },
    });

    const refusalEnv: IntentEnv & Record<string, unknown> = {
      DATABASE_URL,
      // RFC 5737 TEST-NET-1 — guaranteed unroutable. Triggers fetch failure
      // → assessSovereignty returns decision='blocked' (refusal path).
      CHITTYTRUST_URL: 'http://192.0.2.1:1/',
    };

    const result = await executeIntent(refusalEnv, intent.id, {
      actorChittyId: OWNER,
      freshnessMs: 1, // force stale-snapshot branch even if clock skews
    });
    expect(result.ok).toBe(false);
    // FIX 2: dispatch returned replayed:true so executeIntent did not
    // re-call failIntent.
    expect(result.replayed).toBe(true);

    // Exactly one sovereignty_refusal audit row was written by dispatch.
    const auditRows = (await sql`
      SELECT action_type, status FROM cc_actions_log
      WHERE intent_id = ${intent.id}::uuid
    `) as unknown as Array<{ action_type: string; status: string }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action_type).toBe('sovereignty_refusal');
    expect(auditRows[0].status).toBe('failed');

    // cc_intents reached 'failed' with the dispatch-side error message.
    // (failIntent's WHERE clause guards on status IN ('claimed','running'),
    // so a second invocation is a no-op at the DB; the canonical FIX 2
    // signal is `result.replayed === true` above.)
    const intentRows = (await sql`
      SELECT status, error_message FROM cc_intents WHERE id = ${intent.id}::uuid
    `) as unknown as Array<{ status: string; error_message: string | null }>;
    expect(intentRows[0].status).toBe('failed');
    expect(intentRows[0].error_message).toMatch(/sovereignty re-reckon/);
  });
});
