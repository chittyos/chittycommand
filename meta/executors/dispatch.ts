/**
 * Executor dispatcher.
 *
 * Single entry point invoked by `meta/intent.ts::executeIntent` (and any
 * future cron / event-driven path). Responsibilities:
 *
 *   1. Re-reckon sovereignty if the snapshot on the intent is stale
 *      (>= SOVEREIGNTY_FRESHNESS_MS).
 *   2. Compute the attempt number + idempotency key.
 *   3. Replay: if a prior cc_actions_log row exists for
 *      (intent_id, idempotency_key), short-circuit and return the prior result.
 *   4. Look up executor by intent_type; absence is a wiring bug.
 *   5. Call executor; write the cc_actions_log row carrying intent_id +
 *      attempt + idempotency_key.
 *
 * Per ADR-001 amendment (PR-A): this is the SECOND sovereignty gate call
 * point (the first is at Intent creation in meta/intent.ts::createIntent).
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../../src/index';
import type { Intent, SovereigntyAssessmentSnapshot } from '../intent';
import { failIntent } from '../intent';
import { assessSovereignty } from '../sovereignty';
import { getExecutor } from './registry';
import { SOVEREIGNTY_FRESHNESS_MS } from './types';
import type { ExecutorContext, ExecutorResult, ExecutorRunOutput } from './types';

function getSql(env: Env): NeonQueryFunction<false, false> {
  const conn =
    (env as unknown as { DATABASE_URL?: string }).DATABASE_URL ||
    (env as unknown as { HYPERDRIVE?: { connectionString: string } }).HYPERDRIVE
      ?.connectionString;
  if (!conn) {
    throw new Error('[meta/executors/dispatch] No DATABASE_URL or HYPERDRIVE binding');
  }
  return neon(conn);
}

/**
 * Stable, content-addressable idempotency key.
 * Formula: sha256("{intent.id}:{attempt}:{intent.intentType}")
 */
async function computeIdempotencyKey(
  intentId: string,
  attempt: number,
  intentType: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${intentId}:${attempt}:${intentType}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isAssessmentFresh(
  snapshot: SovereigntyAssessmentSnapshot | null,
  windowMs: number,
): boolean {
  if (!snapshot?.assessedAt) return false;
  const t = Date.parse(snapshot.assessedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < windowMs;
}

export interface DispatchOptions {
  /** Override the freshness window (ms). Defaults to SOVEREIGNTY_FRESHNESS_MS. */
  freshnessMs?: number;
  /**
   * Owner ChittyID for re-reckoning. Required when the snapshot is stale and
   * no actor is encoded in the intent metadata. Read from intent.metadata
   * (`actorChittyId` or `ownerChittyId`) if not provided.
   */
  actorChittyId?: string;
}

export async function dispatch(
  intent: Intent,
  env: Env,
  options: DispatchOptions = {},
): Promise<ExecutorResult> {
  const sql = getSql(env);
  const freshnessMs = options.freshnessMs ?? SOVEREIGNTY_FRESHNESS_MS;

  // 1. Replay short-circuit: if any prior cc_actions_log row exists for this
  //    intent that hit a terminal status ('completed' or 'failed'), the intent
  //    has already been dispatched and the second call must NOT re-execute.
  //    The unique partial index on (intent_id, idempotency_key) backs this
  //    invariant for retry attempts; the latest-terminal-row lookup backs the
  //    "intent already done" case.
  const priorRows = (await sql`
    SELECT id, status, response_payload, error_message, idempotency_key, attempt
    FROM cc_actions_log
    WHERE intent_id = ${intent.id}::uuid
      AND status IN ('completed', 'failed')
    ORDER BY executed_at DESC
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    status: string;
    response_payload: Record<string, unknown> | null;
    error_message: string | null;
    idempotency_key: string;
    attempt: number;
  }>;
  if (priorRows[0]) {
    const prior = priorRows[0];
    return {
      ok: prior.status === 'completed',
      idempotencyKey: prior.idempotency_key,
      actionLogId: prior.id,
      data: prior.response_payload ?? undefined,
      error: prior.error_message ?? undefined,
      replayed: true,
    };
  }

  // 2. Compute attempt number (prior rows + 1) and idempotency key for the
  //    new audit row. The partial unique index on (intent_id, idempotency_key)
  //    prevents two concurrent dispatchers from writing duplicate rows for
  //    the same attempt.
  const [{ count: priorCount } = { count: 0 }] = (await sql`
    SELECT COUNT(*)::int AS count FROM cc_actions_log WHERE intent_id = ${intent.id}::uuid
  `) as unknown as Array<{ count: number }>;
  const attempt = (priorCount ?? 0) + 1;
  const idempotencyKey = await computeIdempotencyKey(
    intent.id,
    attempt,
    intent.intentType,
  );

  // 3. Re-reckon sovereignty if snapshot stale.
  let sovereignty: SovereigntyAssessmentSnapshot;
  if (isAssessmentFresh(intent.sovereigntyAssessment, freshnessMs)) {
    sovereignty = intent.sovereigntyAssessment!;
  } else {
    const actor =
      options.actorChittyId ||
      (typeof intent.metadata?.actorChittyId === 'string'
        ? (intent.metadata.actorChittyId as string)
        : undefined) ||
      (typeof intent.metadata?.ownerChittyId === 'string'
        ? (intent.metadata.ownerChittyId as string)
        : undefined);
    if (!actor) {
      const errMsg =
        'sovereignty snapshot stale and no actorChittyId available for re-reckon';
      await writeAuditRow(sql, {
        intentId: intent.id,
        attempt,
        idempotencyKey,
        actionType: 'sovereignty_refusal',
        targetType: 'intent',
        targetId: intent.id,
        description: errMsg,
        status: 'failed',
        errorMessage: errMsg,
        responsePayload: null,
        requestPayload: intent.payload,
        metadata: { reason: 'no_actor_for_reckon' },
      });
      await failIntent(env, intent.id, errMsg).catch(() => null);
      return { ok: false, idempotencyKey, error: errMsg };
    }
    const result = await assessSovereignty(
      actor,
      { intentType: intent.intentType },
      env as unknown as { CHITTYTRUST_URL?: string; CHITTYTRUST_TOKEN?: string },
    );
    sovereignty = {
      decision: result.decision,
      trustScore: result.trustScore,
      reasoning: result.reasoning,
      assessedAt: new Date().toISOString(),
    };
    if (result.decision !== 'autonomous') {
      const refusal = `sovereignty re-reckon: ${result.decision} (${result.reasoning})`;
      const auditId = await writeAuditRow(sql, {
        intentId: intent.id,
        attempt,
        idempotencyKey,
        actionType: 'sovereignty_refusal',
        targetType: 'intent',
        targetId: intent.id,
        description: refusal,
        status: 'failed',
        errorMessage: refusal,
        responsePayload: null,
        requestPayload: intent.payload,
        metadata: { sovereignty },
      });
      await failIntent(env, intent.id, refusal).catch(() => null);
      return {
        ok: false,
        idempotencyKey,
        actionLogId: auditId,
        error: refusal,
      };
    }
  }

  // 4. Look up executor.
  const executor = getExecutor(intent.intentType);
  if (!executor) {
    const errMsg = `[meta/executors/dispatch] No executor registered for intent_type='${intent.intentType}' — this is a wiring bug`;
    throw new Error(errMsg);
  }

  // 5. Execute.
  const ctx: ExecutorContext = {
    env,
    sql,
    intent,
    sovereignty,
    attempt,
    idempotencyKey,
  };
  let runOutput: ExecutorRunOutput;
  try {
    runOutput = await executor.run(ctx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const auditId = await writeAuditRow(sql, {
      intentId: intent.id,
      attempt,
      idempotencyKey,
      actionType: 'executor_error',
      targetType: 'intent',
      targetId: intent.id,
      description: `executor threw: ${errMsg}`,
      status: 'failed',
      errorMessage: errMsg,
      responsePayload: null,
      requestPayload: intent.payload,
      metadata: { sovereignty, canonicalUri: executor.canonicalUri },
    });
    return { ok: false, idempotencyKey, actionLogId: auditId, error: errMsg };
  }

  // 6. Write audit row.
  const auditId = await writeAuditRow(sql, {
    intentId: intent.id,
    attempt,
    idempotencyKey,
    actionType: runOutput.actionType,
    targetType: runOutput.targetType,
    targetId: runOutput.targetId ?? null,
    description: runOutput.description,
    status: runOutput.status,
    errorMessage: runOutput.errorMessage ?? null,
    responsePayload: runOutput.responsePayload ?? null,
    requestPayload: intent.payload,
    metadata: {
      sovereignty,
      canonicalUri: executor.canonicalUri,
      ...(runOutput.metadata ?? {}),
    },
  });

  return {
    ok: runOutput.ok,
    idempotencyKey,
    actionLogId: auditId,
    data: runOutput.responsePayload,
    error: runOutput.errorMessage,
  };
}

interface AuditRow {
  intentId: string;
  attempt: number;
  idempotencyKey: string;
  actionType: string;
  targetType: string;
  targetId: string | null;
  description: string;
  status: string;
  errorMessage: string | null;
  responsePayload: Record<string, unknown> | null;
  requestPayload: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

async function writeAuditRow(
  sql: NeonQueryFunction<false, false>,
  row: AuditRow,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO cc_actions_log
      (intent_id, attempt, idempotency_key, action_type, target_type, target_id,
       description, status, error_message, request_payload, response_payload, metadata)
    VALUES
      (${row.intentId}, ${row.attempt}, ${row.idempotencyKey},
       ${row.actionType}, ${row.targetType}, ${row.targetId},
       ${row.description}, ${row.status}, ${row.errorMessage},
       ${row.requestPayload ? JSON.stringify(row.requestPayload) : null}::jsonb,
       ${row.responsePayload ? JSON.stringify(row.responsePayload) : null}::jsonb,
       ${JSON.stringify(row.metadata)}::jsonb)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(rows[0].id);
}
