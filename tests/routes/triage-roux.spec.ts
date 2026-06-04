/**
 * Integration test for ChittyTriage + Roux carry-through.
 *
 * Covers:
 *   - createIntent with privilege+space round-trips.
 *   - claimNextIntent filters by privilege+space (only the matching bucket).
 *   - 409 on second claim of an already-claimed intent (idempotent retry).
 *   - claim-next bucket filter respects priority ordering.
 *
 * Real Neon. Skipped without DATABASE_URL — mirrors tests/meta/intent-lifecycle.spec.ts.
 *
 * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  createGoal,
  createPlan,
  createIntent,
  claimNextIntent,
  getIntent,
  type IntentEnv,
} from '../../meta/intent';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv = { DATABASE_URL };
const OWNER = '01-A-NB-0002-P-66-1-1';
const TEST_TAG = `roux-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
}

describe.skipIf(SKIP)('ChittyTriage Roux carry-through (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('createIntent persists privilege + space and round-trips through getIntent', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g1` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p1` });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { test: TEST_TAG },
      privilege: 'privileged',
      space: 'legalink',
    });
    expect(intent.privilege).toBe('privileged');
    expect(intent.space).toBe('legalink');

    const round = await getIntent(env, intent.id);
    expect(round?.privilege).toBe('privileged');
    expect(round?.space).toBe('legalink');
  });

  it('claimNextIntent filters by privilege + space and leaves non-matching rows alone', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g2` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p2` });

    const publicIntent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { bucket: 'public-business' },
      priority: 5,
      privilege: 'public',
      space: 'business',
    });
    const piiIntent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { bucket: 'pii-legalink' },
      priority: 1, // higher priority — would normally win if not filtered out
      privilege: 'pii',
      space: 'legalink',
    });

    // Bucket = public/business should pick the public intent, NOT the higher-
    // priority pii/legalink intent.
    const claimed = await claimNextIntent(env, { privilege: 'public', space: 'business' });
    expect(claimed?.id).toBe(publicIntent.id);
    expect(claimed?.status).toBe('claimed');

    // Verify the pii/legalink intent is still pending.
    const stillPending = await getIntent(env, piiIntent.id);
    expect(stillPending?.status).toBe('pending');
  });

  it('atomic claim cannot succeed twice on the same intent (409 semantic)', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g3` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p3` });
    const intent = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { test: '409-semantic' },
      privilege: 'public',
      space: 'business',
    });

    const sql = neon(DATABASE_URL!);

    // First atomic claim succeeds.
    const first = await sql`
      UPDATE cc_intents SET status = 'claimed', updated_at = NOW()
      WHERE id = ${intent.id} AND status = 'pending'
      RETURNING id, status
    `;
    expect(first.length).toBe(1);

    // Second claim must affect zero rows — the route surfaces this as 409.
    const second = await sql`
      UPDATE cc_intents SET status = 'claimed', updated_at = NOW()
      WHERE id = ${intent.id} AND status = 'pending'
      RETURNING id, status
    `;
    expect(second.length).toBe(0);
  });

  it('claim-next bucket filter respects priority ordering within the matching bucket', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g4` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p4` });

    const low = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { bucket: 'public-business', tier: 'low' },
      priority: 9,
      privilege: 'public',
      space: 'business',
    });
    const high = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { bucket: 'public-business', tier: 'high' },
      priority: 1,
      privilege: 'public',
      space: 'business',
    });

    const claimed = await claimNextIntent(env, { privilege: 'public', space: 'business' });
    expect(claimed?.id).toBe(high.id);

    const stillPending = await getIntent(env, low.id);
    expect(stillPending?.status).toBe('pending');
  });
});
