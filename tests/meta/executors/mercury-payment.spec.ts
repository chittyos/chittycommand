/**
 * Integration test for meta/executors/mercury-payment.ts.
 *
 * Covers (REAL MONEY PATH — additional gates beyond PR #106):
 *   - Refusal: sovereignty snapshot older than 60s (executor's belt-and-
 *     suspenders gate; we DELIBERATELY do not override `freshnessMs` on
 *     executeIntent so the snapshot survives dispatch's default 5min
 *     window and reaches the executor stale-by-money-path-standard).
 *   - Refusal: amount cap exceeded.
 *   - Idempotency: second executeIntent for the same intent does not
 *     re-call Mercury and replays the prior cc_actions_log row.
 *
 * Real Neon only. Skipped without DATABASE_URL. Mercury network calls are
 * NEVER made by these tests — every test exercises a refusal path that
 * terminates BEFORE the executor reaches `mercuryClient.createPayment`.
 *
 * To exercise an actual Mercury sandbox call, set
 *   MERCURY_INTEGRATION_TEST=1
 * and provide a Mercury token in KV for `mercury:token:test-sandbox` plus a
 * real sandbox recipient — that branch is intentionally not implemented in
 * this file because the chittycommand repo has no Mercury sandbox harness.
 * The operator runbook documents the manual procedure.
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
} from '../../../meta/intent';
import '../../../meta/executors';
import {
  MERCURY_PAYMENT_INTENT,
  MERCURY_SOVEREIGNTY_FRESHNESS_MS,
} from '../../../meta/executors/mercury-payment';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

// Minimal KV stub — never returns a token, so any code path that reaches the
// token lookup will refuse with 'missing_token' instead of attempting a
// Mercury HTTP call. All three primary refusal cases below short-circuit
// BEFORE this is touched; it is here only as a final safety net.
const KV_STUB = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => undefined,
  list: async () => ({ keys: [], list_complete: true, cursor: '' }),
} as unknown as KVNamespace;

const env: IntentEnv & Record<string, unknown> = {
  DATABASE_URL,
  MERCURY_AUTONOMOUS_AMOUNT_CAP_USD: '500',
  COMMAND_KV: KV_STUB,
};

const OWNER = '01-A-NB-0001-P-66-1-1';
const TEST_TAG = `merc-exec-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
}

interface MakeIntentArgs {
  amountCents: number;
  assessedAt: string;
  decision?: SovereigntyAssessmentSnapshot['decision'];
}

async function makeIntent(args: MakeIntentArgs): Promise<string> {
  const goal = await createGoal(env, {
    ownerChittyId: OWNER,
    title: `${TEST_TAG}-goal-${crypto.randomUUID().slice(0, 8)}`,
  });
  const plan = await createPlan(env, {
    goalId: goal.id,
    title: `${TEST_TAG}-plan`,
  });
  const sovereignty: SovereigntyAssessmentSnapshot = {
    decision: args.decision ?? 'autonomous',
    trustScore: 0.95,
    reasoning: 'pre-seeded for mercury_payment integration test',
    assessedAt: args.assessedAt,
  };
  const intent = await createIntent(env, {
    planId: plan.id,
    goalId: goal.id,
    intentType: MERCURY_PAYMENT_INTENT,
    payload: {
      account_slug: 'test-sandbox',
      mercury_account_id: 'acct_test_0001',
      recipient_id: 'rcpt_test_0001',
      amount_cents: args.amountCents,
      currency: 'USD',
      memo: TEST_TAG,
    },
    sovereigntyAssessment: sovereignty,
    metadata: { actorChittyId: OWNER },
  });
  return intent.id;
}

describe.skipIf(SKIP)('meta/executors/mercury-payment — refusal gates (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('refuses when sovereignty snapshot is older than 60s (money-path freshness)', async () => {
    // Snapshot is 2 minutes old. Dispatch's default freshness is 5 minutes,
    // so dispatch passes the snapshot through unmodified. The executor's
    // own 60s check then catches it.
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const intentId = await makeIntent({ amountCents: 1_00, assessedAt: twoMinAgo });

    // No freshnessMs override — we want dispatch's 5-min window so the
    // stale-by-money-standard snapshot reaches the executor.
    const result = await executeIntent(env, intentId, { actorChittyId: OWNER });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sovereignty snapshot older than/);

    const sql = neon(DATABASE_URL!);
    const rows = (await sql`
      SELECT action_type, status, error_message, idempotency_key, attempt, metadata
      FROM cc_actions_log
      WHERE intent_id = ${intentId}::uuid
    `) as unknown as Array<{
      action_type: string;
      status: string;
      error_message: string;
      idempotency_key: string;
      attempt: number;
      metadata: Record<string, unknown>;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].action_type).toBe('payment_refusal');
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].error_message).toMatch(/sovereignty snapshot older than/);
  });

  it('refuses when amount_cents exceeds the autonomous cap', async () => {
    const fresh = new Date().toISOString();
    // Cap is 500 USD = 50_000 cents. 50_001 must refuse.
    const intentId = await makeIntent({ amountCents: 50_001, assessedAt: fresh });

    // Pass tight freshness window so dispatch does not re-reckon (which
    // would call trust.chitty.cc in the test env). The executor still
    // enforces the amount cap.
    const result = await executeIntent(env, intentId, {
      actorChittyId: OWNER,
      freshnessMs: MERCURY_SOVEREIGNTY_FRESHNESS_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds autonomous cap/);

    const sql = neon(DATABASE_URL!);
    const rows = (await sql`
      SELECT action_type, status, error_message, metadata
      FROM cc_actions_log
      WHERE intent_id = ${intentId}::uuid
    `) as unknown as Array<{
      action_type: string;
      status: string;
      error_message: string;
      metadata: Record<string, unknown>;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].action_type).toBe('payment_refusal');
    expect(rows[0].status).toBe('failed');
    expect((rows[0].metadata as { refusal_reason?: string }).refusal_reason).toBe(
      'amount_cap_exceeded',
    );
  });

  it('is idempotent on replay — second executeIntent reuses the prior audit row', async () => {
    // Use an under-cap amount with a fresh snapshot. KV stub returns null,
    // so the executor refuses at the 'missing_token' gate (still a refusal
    // path; the dispatcher writes a single audit row). Replay of the same
    // intent MUST short-circuit on the dispatcher's prior-terminal-row
    // lookup and not produce a second row.
    const fresh = new Date().toISOString();
    const intentId = await makeIntent({ amountCents: 1_00, assessedAt: fresh });

    const first = await executeIntent(env, intentId, {
      actorChittyId: OWNER,
      freshnessMs: MERCURY_SOVEREIGNTY_FRESHNESS_MS,
    });
    expect(first.ok).toBe(false);
    expect(first.replayed).toBeFalsy();
    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    const second = await executeIntent(env, intentId, {
      actorChittyId: OWNER,
      freshnessMs: MERCURY_SOVEREIGNTY_FRESHNESS_MS,
    });
    expect(second.replayed).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.actionLogId).toBe(first.actionLogId);

    const sql = neon(DATABASE_URL!);
    const rows = (await sql`
      SELECT id FROM cc_actions_log WHERE intent_id = ${intentId}::uuid
    `) as unknown as Array<{ id: string }>;
    expect(rows.length).toBe(1);
  });
});
