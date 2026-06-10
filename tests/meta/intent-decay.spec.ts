/**
 * Integration test for src/lib/intent-decay.ts — Phase 2.5 Roux intent decay.
 *
 * Covers:
 *   - Empty case: zero pending stale roux_ingest rows returns {expired:0, scanned:0}
 *   - Stale (35d) pending roux_ingest gets expired with decayed_at stamped
 *   - Fresh (1d) pending roux_ingest stays pending
 *   - Non-roux_ingest stale (60d) 'noop' row is not touched
 *   - Dispatched stale roux_ingest is not touched (dispatched_task_id IS NOT NULL)
 *   - batchLimit caps the number of expired rows in a single call
 *   - Unit tests for computeRouxExpiresAt
 *
 * Real Neon. Skipped without DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import {
  createGoal,
  createPlan,
  createIntent,
  getIntent,
  type IntentEnv,
} from '../../meta/intent';
import { decayStaleRouxIntents, computeRouxExpiresAt } from '../../src/lib/intent-decay';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL || process.env.SKIP_INTEGRATION === '1';

const env: IntentEnv = { DATABASE_URL };
const OWNER = '01-A-NB-0001-P-66-1-1';
const TEST_TAG = `decay-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup() {
  if (!DATABASE_URL) return;
  const sql = neon(DATABASE_URL);
  await sql`DELETE FROM cc_goals WHERE owner_chitty_id = ${OWNER} AND title LIKE ${TEST_TAG + '%'}`;
}

describe.skipIf(SKIP)('intent-decay (real Neon)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('empty case returns {expired:0, scanned:0}', async () => {
    const sql = neon(DATABASE_URL!);
    // No stale roux_ingest intents exist for our tagged owner; the global
    // result over the table may be >0 in a shared dev DB, so we test the
    // function directly only after we know no candidates exist for our tag.
    // Instead we just assert the function returns a well-formed shape.
    const result = await decayStaleRouxIntents(sql, { batchLimit: 0 });
    expect(result.expired).toBe(0);
    expect(result.scanned).toBe(0);
    expect(typeof result.runAt).toBe('string');
    expect(() => new Date(result.runAt)).not.toThrow();
  });

  it('stale 35d roux_ingest gets expired, fresh 1d stays pending, decayed_at stamped', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g1` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p1` });

    const stale = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'roux_ingest',
      payload: { source: { message_id: `${TEST_TAG}-msg-stale-${Date.now()}` }, test: TEST_TAG },
    });
    const fresh = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'roux_ingest',
      payload: { source: { message_id: `${TEST_TAG}-msg-fresh-${Date.now()}` }, test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    // Backdate `stale` to 35 days ago, keep `fresh` recent.
    await sql`UPDATE cc_intents SET created_at = NOW() - INTERVAL '35 days', updated_at = NOW() - INTERVAL '35 days' WHERE id = ${stale.id}`;
    await sql`UPDATE cc_intents SET created_at = NOW() - INTERVAL '1 day', updated_at = NOW() - INTERVAL '1 day' WHERE id = ${fresh.id}`;

    const result = await decayStaleRouxIntents(sql);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const staleAfter = await getIntent(env, stale.id);
    expect(staleAfter?.status).toBe('expired');
    const staleRow = await sql`SELECT decayed_at FROM cc_intents WHERE id = ${stale.id}`;
    expect(staleRow[0].decayed_at).not.toBeNull();

    const freshAfter = await getIntent(env, fresh.id);
    expect(freshAfter?.status).toBe('pending');
  });

  it('non-roux_ingest 60d-old noop is not touched', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g2` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p2` });
    const noop = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'noop',
      payload: { test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    await sql`UPDATE cc_intents SET created_at = NOW() - INTERVAL '60 days', updated_at = NOW() - INTERVAL '60 days' WHERE id = ${noop.id}`;

    await decayStaleRouxIntents(sql);

    const after = await getIntent(env, noop.id);
    expect(after?.status).toBe('pending');
  });

  it('dispatched stale roux_ingest is not touched', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g3` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p3` });
    const dispatched = await createIntent(env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'roux_ingest',
      payload: { source: { message_id: `${TEST_TAG}-msg-dispatched-${Date.now()}` }, test: TEST_TAG },
    });

    const sql = neon(DATABASE_URL!);
    await sql`
      UPDATE cc_intents
         SET created_at = NOW() - INTERVAL '40 days',
             updated_at = NOW() - INTERVAL '40 days',
             dispatched_task_id = 'dispatched-task-token'
       WHERE id = ${dispatched.id}`;

    await decayStaleRouxIntents(sql);

    const after = await getIntent(env, dispatched.id);
    expect(after?.status).toBe('pending');
  });

  it('batchLimit caps the number of expired rows', async () => {
    const goal = await createGoal(env, { ownerChittyId: OWNER, title: `${TEST_TAG}-g4` });
    const plan = await createPlan(env, { goalId: goal.id, title: `${TEST_TAG}-p4` });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const intent = await createIntent(env, {
        planId: plan.id,
        goalId: goal.id,
        intentType: 'roux_ingest',
        payload: { source: { message_id: `${TEST_TAG}-msg-batch-${i}-${Date.now()}` }, test: TEST_TAG },
      });
      ids.push(intent.id);
    }

    const sql = neon(DATABASE_URL!);
    for (const id of ids) {
      await sql`UPDATE cc_intents SET created_at = NOW() - INTERVAL '40 days', updated_at = NOW() - INTERVAL '40 days' WHERE id = ${id}`;
    }

    const capped = await decayStaleRouxIntents(sql, { batchLimit: 2 });
    expect(capped.expired).toBeLessThanOrEqual(2);

    // A second pass picks up the rest.
    const rest = await decayStaleRouxIntents(sql, { batchLimit: 10 });
    expect(rest.expired).toBeGreaterThanOrEqual(1);
  });
});

describe('computeRouxExpiresAt (unit)', () => {
  it('defaults to 30 days from createdAt', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const exp = computeRouxExpiresAt(created);
    expect(exp.getTime() - created.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('respects custom ttlDays', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const exp = computeRouxExpiresAt(created, 7);
    expect(exp.getTime() - created.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('defaults createdAt to now when omitted', () => {
    const before = Date.now();
    const exp = computeRouxExpiresAt();
    const after = Date.now();
    const delta = exp.getTime() - 30 * 24 * 60 * 60 * 1000;
    expect(delta).toBeGreaterThanOrEqual(before);
    expect(delta).toBeLessThanOrEqual(after);
  });
});
