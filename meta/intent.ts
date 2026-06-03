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
  | 'blocked_human';

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

  const rows = await sql`
    INSERT INTO cc_intents
      (plan_id, goal_id, intent_type, target_channel, payload, status, priority,
       sovereignty_assessment, human_gate_reason, scheduled_for, metadata)
    VALUES
      (${input.planId}, ${input.goalId}, ${input.intentType},
       ${input.targetChannel ?? null}, ${JSON.stringify(input.payload)}::jsonb,
       ${initialStatus}, ${input.priority ?? 5},
       ${input.sovereigntyAssessment ? JSON.stringify(input.sovereigntyAssessment) : null}::jsonb,
       ${input.humanGateReason ?? null}, ${input.scheduledFor ?? null},
       ${JSON.stringify(input.metadata ?? {})}::jsonb)
    RETURNING *`;
  return rowToIntent(rows[0]);
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
export async function claimNextIntent(
  env: IntentEnv,
  options: { channel?: string } = {},
): Promise<Intent | null> {
  const sql = getSql(env);
  const rows = options.channel
    ? await sql`
        UPDATE cc_intents
        SET status = 'claimed', updated_at = NOW()
        WHERE id = (
          SELECT id FROM cc_intents
          WHERE status = 'pending'
            AND target_channel = ${options.channel}
            AND (scheduled_for IS NULL OR scheduled_for <= NOW())
          ORDER BY priority ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *`
    : await sql`
        UPDATE cc_intents
        SET status = 'claimed', updated_at = NOW()
        WHERE id = (
          SELECT id FROM cc_intents
          WHERE status = 'pending'
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

export async function completeIntent(env: IntentEnv, intentId: string): Promise<Intent | null> {
  const sql = getSql(env);
  const rows = await sql`
    UPDATE cc_intents
    SET status = 'done', completed_at = NOW(), updated_at = NOW()
    WHERE id = ${intentId}
    RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
}

export async function failIntent(
  env: IntentEnv,
  intentId: string,
  errorMessage: string,
): Promise<Intent | null> {
  const sql = getSql(env);
  const rows = await sql`
    UPDATE cc_intents
    SET status = 'failed', error_message = ${errorMessage},
        completed_at = NOW(), updated_at = NOW()
    WHERE id = ${intentId}
    RETURNING *`;
  return rows[0] ? rowToIntent(rows[0]) : null;
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
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}
