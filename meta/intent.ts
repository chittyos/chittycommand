/**
 * Meta-orchestrator — Goal → Plan → Intent ladder.
 *
 * Real Drizzle-backed CRUD over cc_goals / cc_plans / cc_intents.
 * Schema lives in src/db/schema.ts. Migration: 0002_naive_mac_gargan.sql.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { ccGoals, ccPlans, ccIntents } from '../src/db/schema';

export type GoalStatus = 'open' | 'planning' | 'active' | 'achieved' | 'abandoned';
export type PlanStatus = 'draft' | 'active' | 'superseded' | 'completed' | 'abandoned';
export type IntentStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked_human'
  | 'expired';

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// ChittyRoux privilege class — orthogonal to sovereignty trust-tier sensitivity.
export type IntentPrivilege = 'privileged' | 'pii' | 'hoa_evidentiary' | 'public';

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// ChittyRoux two-Space partition.
export type IntentSpace = 'business' | 'legalink';

export interface SovereigntyAssessmentSnapshot {
  decision: 'autonomous' | 'requires_human' | 'blocked';
  trustScore: number;
  reasoning: string;
  assessedAt: string;
}

export interface IntentEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

export interface Goal {
  id: string;
  ownerChittyId: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  priority: number;
  targetDate: Date | null;
  achievedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Plan {
  id: string;
  goalId: string;
  title: string;
  rationale: string | null;
  status: PlanStatus;
  supersedesPlanId: string | null;
  authoredBy: string | null;
  sovereigntyAssessment: SovereigntyAssessmentSnapshot | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Intent {
  id: string;
  planId: string;
  goalId: string;
  intentType: string;
  targetChannel: string | null;
  payload: Record<string, unknown>;
  status: IntentStatus;
  priority: number;
  sovereigntyAssessment: SovereigntyAssessmentSnapshot | null;
  humanGateReason: string | null;
  dispatchedTaskId: string | null;
  scheduledFor: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  privilege: IntentPrivilege;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  space: IntentSpace;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Re-export Drizzle tables so callers using a drizzle-orm query builder
// can compose against the same schema definitions.
export { ccGoals, ccPlans, ccIntents };

function getSql(env: IntentEnv): NeonQueryFunction<false, false> {
  const conn = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  if (!conn) {
    throw new Error('[meta/intent] No DATABASE_URL or HYPERDRIVE connection string available');
  }
  return neon(conn);
}

// ── Goals ────────────────────────────────────────────────────

export interface CreateGoalInput {
  ownerChittyId: string;
  title: string;
  description?: string;
  priority?: number;
  targetDate?: Date;
  metadata?: Record<string, unknown>;
}

export async function createGoal(env: IntentEnv, input: CreateGoalInput): Promise<Goal> {
  const sql = getSql(env);
  const rows = await sql`
    INSERT INTO cc_goals
      (owner_chitty_id, title, description, priority, target_date, metadata, status)
    VALUES
      (${input.ownerChittyId}, ${input.title}, ${input.description ?? null},
       ${input.priority ?? 5}, ${input.targetDate ?? null},
       ${JSON.stringify(input.metadata ?? {})}::jsonb, 'open')
    RETURNING *`;
  return rowToGoal(rows[0]);
}

export async function getGoal(env: IntentEnv, id: string): Promise<Goal | null> {
  const sql = getSql(env);
  const rows = await sql`SELECT * FROM cc_goals WHERE id = ${id} LIMIT 1`;
  return rows[0] ? rowToGoal(rows[0]) : null;
}

export async function listGoalsForOwner(
  env: IntentEnv,
  ownerChittyId: string,
  status?: GoalStatus,
): Promise<Goal[]> {
  const sql = getSql(env);
  const rows = status
    ? await sql`
        SELECT * FROM cc_goals
        WHERE owner_chitty_id = ${ownerChittyId} AND status = ${status}
        ORDER BY priority ASC, created_at DESC`
    : await sql`
        SELECT * FROM cc_goals
        WHERE owner_chitty_id = ${ownerChittyId}
        ORDER BY priority ASC, created_at DESC`;
  return rows.map(rowToGoal);
}

// ── Plans ────────────────────────────────────────────────────

export interface CreatePlanInput {
  goalId: string;
  title: string;
  rationale?: string;
  authoredBy?: string;
  supersedesPlanId?: string;
  sovereigntyAssessment?: SovereigntyAssessmentSnapshot;
  metadata?: Record<string, unknown>;
}

export async function createPlan(env: IntentEnv, input: CreatePlanInput): Promise<Plan> {
  const sql = getSql(env);
  const rows = await sql`
    INSERT INTO cc_plans
      (goal_id, title, rationale, status, supersedes_plan_id, authored_by,
       sovereignty_assessment, metadata)
    VALUES
      (${input.goalId}, ${input.title}, ${input.rationale ?? null}, 'draft',
       ${input.supersedesPlanId ?? null}, ${input.authoredBy ?? null},
       ${input.sovereigntyAssessment ? JSON.stringify(input.sovereigntyAssessment) : null}::jsonb,
       ${JSON.stringify(input.metadata ?? {})}::jsonb)
    RETURNING *`;
  return rowToPlan(rows[0]);
}

export async function getPlan(env: IntentEnv, id: string): Promise<Plan | null> {
  const sql = getSql(env);
  const rows = await sql`SELECT * FROM cc_plans WHERE id = ${id} LIMIT 1`;
  return rows[0] ? rowToPlan(rows[0]) : null;
}

export async function listPlansForGoal(env: IntentEnv, goalId: string): Promise<Plan[]> {
  const sql = getSql(env);
  const rows = await sql`
    SELECT * FROM cc_plans WHERE goal_id = ${goalId} ORDER BY created_at DESC`;
  return rows.map(rowToPlan);
}

// ── Intents ──────────────────────────────────────────────────

export interface CreateIntentInput {
  planId: string;
  goalId: string;
  intentType: string;
  payload: Record<string, unknown>;
  targetChannel?: string;
  priority?: number;
  sovereigntyAssessment?: SovereigntyAssessmentSnapshot;
  humanGateReason?: string;
  scheduledFor?: Date;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  privilege?: IntentPrivilege;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  space?: IntentSpace;
  metadata?: Record<string, unknown>;
}

export async function createIntent(env: IntentEnv, input: CreateIntentInput): Promise<Intent> {
  const sql = getSql(env);
  // If the sovereignty gate says requires_human or blocked, persist that as the
  // initial status so the executor never picks it up.
  const initialStatus: IntentStatus =
    input.sovereigntyAssessment?.decision === 'requires_human'
      ? 'blocked_human'
      : input.sovereigntyAssessment?.decision === 'blocked'
        ? 'failed'
        : 'pending';

  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  // privilege/space default to public/business at the column level; pass through
  // explicit caller values so high-privilege intents are tagged at creation.
  const rows = await sql`
    INSERT INTO cc_intents
      (plan_id, goal_id, intent_type, target_channel, payload, status, priority,
       sovereignty_assessment, human_gate_reason, scheduled_for, privilege, space, metadata)
    VALUES
      (${input.planId}, ${input.goalId}, ${input.intentType},
       ${input.targetChannel ?? null}, ${JSON.stringify(input.payload)}::jsonb,
       ${initialStatus}, ${input.priority ?? 5},
       ${input.sovereigntyAssessment ? JSON.stringify(input.sovereigntyAssessment) : null}::jsonb,
       ${input.humanGateReason ?? null}, ${input.scheduledFor ?? null},
       ${input.privilege ?? 'public'}, ${input.space ?? 'business'},
       ${JSON.stringify(input.metadata ?? {})}::jsonb)
    RETURNING *`;
  return rowToIntent(rows[0]);
}

/**
 * Atomic create-or-fetch for roux_ingest intents keyed by Gmail message_id.
 *
 * Backed by the partial unique index `cc_intents_roux_ingest_message_id_uidx`
 * (migration 0017). Two concurrent retries of the same Gmail event race on
 * INSERT; the loser hits the unique violation and we re-SELECT to return the
 * winner's row. Eliminates the TOCTOU window of SELECT-then-INSERT.
 *
 * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
 */
export async function createRouxIngestIntentIdempotent(
  env: IntentEnv,
  input: CreateIntentInput & { messageId: string },
): Promise<{ intent: Intent; created: boolean }> {
  const sql = getSql(env);
  const initialStatus: IntentStatus =
    input.sovereigntyAssessment?.decision === 'requires_human'
      ? 'blocked_human'
      : input.sovereigntyAssessment?.decision === 'blocked'
        ? 'failed'
        : 'pending';

  const inserted = await sql`
    INSERT INTO cc_intents
      (plan_id, goal_id, intent_type, target_channel, payload, status, priority,
       sovereignty_assessment, human_gate_reason, scheduled_for, privilege, space, metadata)
    VALUES
      (${input.planId}, ${input.goalId}, ${input.intentType},
       ${input.targetChannel ?? null}, ${JSON.stringify(input.payload)}::jsonb,
       ${initialStatus}, ${input.priority ?? 5},
       ${input.sovereigntyAssessment ? JSON.stringify(input.sovereigntyAssessment) : null}::jsonb,
       ${input.humanGateReason ?? null}, ${input.scheduledFor ?? null},
       ${input.privilege ?? 'public'}, ${input.space ?? 'business'},
       ${JSON.stringify(input.metadata ?? {})}::jsonb)
    ON CONFLICT ((payload->'source'->>'message_id'))
      WHERE intent_type = 'roux_ingest'
        AND payload->'source'->>'message_id' IS NOT NULL
      DO NOTHING
    RETURNING *`;
  if (inserted[0]) {
    return { intent: rowToIntent(inserted[0]), created: true };
  }
  // Conflict — re-fetch the winner.
  const winner = await sql`
    SELECT * FROM cc_intents
    WHERE intent_type = 'roux_ingest'
      AND payload->'source'->>'message_id' = ${input.messageId}
    LIMIT 1`;
  if (!winner[0]) {
    throw new Error(`ON CONFLICT path with no winning row for message_id=${input.messageId}`);
  }
  return { intent: rowToIntent(winner[0]), created: false };
}

export async function getIntent(env: IntentEnv, id: string): Promise<Intent | null> {
  const sql = getSql(env);
  const rows = await sql`SELECT * FROM cc_intents WHERE id = ${id} LIMIT 1`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

/**
 * Claim the next pending intent for execution. Atomic via UPDATE...RETURNING.
 * Mirrors the lease pattern in chittyentity/workers/shared/agent-tasks.ts.
 */
// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// privilege/space filters use the null-passthrough pattern (param IS NULL OR
// col = param) so a single prepared statement covers all four filter combos.
export async function claimNextIntent(
  env: IntentEnv,
  options: {
    channel?: string;
    privilege?: IntentPrivilege;
    space?: IntentSpace;
    priorityLte?: number;
  } = {},
): Promise<Intent | null> {
  const sql = getSql(env);
  const channel = options.channel ?? null;
  const privilege = options.privilege ?? null;
  const space = options.space ?? null;
  const priorityLte = options.priorityLte ?? null;
  const rows = await sql`
    UPDATE cc_intents
    SET status = 'claimed', updated_at = NOW()
    WHERE id = (
      SELECT id FROM cc_intents
      WHERE status = 'pending'
        AND (${channel}::text IS NULL OR target_channel = ${channel})
        AND (${privilege}::text IS NULL OR privilege = ${privilege})
        AND (${space}::text IS NULL OR space = ${space})
        AND (${priorityLte}::int IS NULL OR priority <= ${priorityLte})
        AND (scheduled_for IS NULL OR scheduled_for <= NOW())
      ORDER BY priority ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

export async function markIntentDispatched(
  env: IntentEnv,
  intentId: string,
  dispatchedTaskId: string,
): Promise<Intent | null> {
  const sql = getSql(env);
  const rows = await sql`
    UPDATE cc_intents
    SET status = 'running', dispatched_task_id = ${dispatchedTaskId}, updated_at = NOW()
    WHERE id = ${intentId} AND status = 'claimed'
    RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

// fixes codex-p2 PR#101 finding-6 — only flip to 'done' if still running.
// Without the guard, a parallel cancellation/failure path that set status to
// 'failed' or 'blocked_human' would be silently overwritten here.
//
// fixes codex-p2 PR#103 P1-B — also gate on the execution token (the
// dispatched_task_id captured at dispatch time). If a stale leader's executor
// returns after a fresher leader has reclaimed + redispatched the intent, the
// stale dispatched_task_id will no longer match and the UPDATE will affect 0
// rows. Pass `undefined` to skip the token check (legacy / non-leader paths).
// fixes codex-p2 PR#104 finding-4 — accept 'claimed' as well as 'running'.
// The triage routes expose claim (→'claimed') but no explicit transition to
// 'running', so an autonomous agent that does work and then calls complete
// always hit 409. The token gate from P1-B still prevents stale completions
// when a token is supplied. Failing from terminal states is still rejected.
export async function completeIntent(
  env: IntentEnv,
  intentId: string,
  expectedDispatchedTaskId?: string,
): Promise<Intent | null> {
  const sql = getSql(env);
  const rows =
    expectedDispatchedTaskId === undefined
      ? await sql`
          UPDATE cc_intents
          SET status = 'done', completed_at = NOW(), updated_at = NOW()
          WHERE id = ${intentId} AND status IN ('claimed', 'running')
          RETURNING *`
      : await sql`
          UPDATE cc_intents
          SET status = 'done', completed_at = NOW(), updated_at = NOW()
          WHERE id = ${intentId}
            AND status IN ('claimed', 'running')
            AND dispatched_task_id = ${expectedDispatchedTaskId}
          RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

// fixes codex-p2 PR#101 finding-6 — symmetric guard on the failure path.
// Allow failing from 'claimed' or 'running' (executor can blow up before
// markIntentDispatched lands), but never overwrite a terminal state.
//
// fixes codex-p2 PR#103 P1-B — optional execution-token gate. When the
// executor threw AFTER a successful dispatch, callers should pass the
// dispatched_task_id from markIntentDispatched so a stale leader's failure
// path cannot mark a fresher leader's running execution as failed. When the
// executor threw BEFORE dispatch (markIntentDispatched returned null or was
// never called), callers omit the token and the legacy 'claimed' or 'running'
// guard still applies.
export async function failIntent(
  env: IntentEnv,
  intentId: string,
  errorMessage: string,
  expectedDispatchedTaskId?: string,
): Promise<Intent | null> {
  const sql = getSql(env);
  const rows =
    expectedDispatchedTaskId === undefined
      ? await sql`
          UPDATE cc_intents
          SET status = 'failed', error_message = ${errorMessage},
              completed_at = NOW(), updated_at = NOW()
          WHERE id = ${intentId} AND status IN ('claimed', 'running')
          RETURNING *`
      : await sql`
          UPDATE cc_intents
          SET status = 'failed', error_message = ${errorMessage},
              completed_at = NOW(), updated_at = NOW()
          WHERE id = ${intentId}
            AND status IN ('claimed', 'running')
            AND dispatched_task_id = ${expectedDispatchedTaskId}
          RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

/**
 * Reset intents stuck in `status='running'` past `maxRunningSeconds` back to
 * `status='pending'`, incrementing `reclaim_count` so persistent failures are
 * visible. Idempotent — returns the number of rows reclaimed.
 *
 * cc_intents has no claimed_by/claimed_at columns; staleness is measured via
 * `updated_at` (which the dispatch/heartbeat paths bump) and `dispatched_task_id`
 * is cleared so a fresh dispatch can replace it.
 *
 * Called by daemon/loop.ts once per leader tick before claiming new work.
 *
 * fixes codex-p2 PR#101 finding-1
 */
export async function reclaimStuckIntents(
  env: IntentEnv,
  maxRunningSeconds: number,
): Promise<number> {
  if (!Number.isFinite(maxRunningSeconds) || maxRunningSeconds <= 0) {
    throw new Error('[meta/intent] reclaimStuckIntents requires maxRunningSeconds > 0');
  }
  const sql = getSql(env);
  const rows = await sql`
    UPDATE cc_intents
    SET status = 'pending',
        dispatched_task_id = NULL,
        error_message = NULL,
        reclaim_count = reclaim_count + 1,
        updated_at = NOW()
    WHERE status IN ('claimed', 'running')
      AND updated_at < NOW() - (${Math.floor(maxRunningSeconds)} * INTERVAL '1 second')
    RETURNING id`;
  return rows.length;
}

// ── Row mappers ─────────────────────────────────────────────

function rowToGoal(row: Record<string, unknown>): Goal {
  return {
    id: String(row.id),
    ownerChittyId: String(row.owner_chitty_id),
    title: String(row.title),
    description: (row.description as string) ?? null,
    status: row.status as GoalStatus,
    priority: Number(row.priority),
    targetDate: row.target_date ? new Date(row.target_date as string) : null,
    achievedAt: row.achieved_at ? new Date(row.achieved_at as string) : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToPlan(row: Record<string, unknown>): Plan {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    title: String(row.title),
    rationale: (row.rationale as string) ?? null,
    status: row.status as PlanStatus,
    supersedesPlanId: (row.supersedes_plan_id as string) ?? null,
    authoredBy: (row.authored_by as string) ?? null,
    sovereigntyAssessment:
      (row.sovereignty_assessment as SovereigntyAssessmentSnapshot | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToIntent(row: Record<string, unknown>): Intent {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    goalId: String(row.goal_id),
    intentType: String(row.intent_type),
    targetChannel: (row.target_channel as string) ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as IntentStatus,
    priority: Number(row.priority),
    sovereigntyAssessment:
      (row.sovereignty_assessment as SovereigntyAssessmentSnapshot | null) ?? null,
    humanGateReason: (row.human_gate_reason as string) ?? null,
    dispatchedTaskId: (row.dispatched_task_id as string) ?? null,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for as string) : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    errorMessage: (row.error_message as string) ?? null,
    // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
    privilege: ((row.privilege as IntentPrivilege | undefined) ?? 'public'),
    // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
    space: ((row.space as IntentSpace | undefined) ?? 'business'),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}
