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
import type { Intent, SovereigntyAssessmentSnapshot } from '../intent';
import { failIntent } from '../intent';
import { assessSovereignty } from '../sovereignty';
import { getExecutor } from './registry';
import { SOVEREIGNTY_FRESHNESS_MS } from './types';
import type { ExecutorContext, ExecutorEnv, ExecutorResult, ExecutorRunOutput } from './types';

function getSql(env: ExecutorEnv): NeonQueryFunction<false, false> {
  const conn = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
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
  env: ExecutorEnv,
  options: DispatchOptions = {},
): Promise<ExecutorResult> {
  const sql = getSql(env);
  const freshnessMs = options.freshnessMs ?? SOVEREIGNTY_FRESHNESS_MS;

  // 1. Compute attempt number (prior rows + 1) and per-attempt idempotency
  //    key. The partial unique index on (intent_id, idempotency_key) backs
  //    the per-attempt invariant.
  const [{ count: priorCount } = { count: 0 }] = (await sql`
    SELECT COUNT(*)::int AS count FROM cc_actions_log WHERE intent_id = ${intent.id}::uuid
  `) as unknown as Array<{ count: number }>;
  const attempt = (priorCount ?? 0) + 1;
  const idempotencyKey = await computeIdempotencyKey(
    intent.id,
    attempt,
    intent.intentType,
  );

  // 2. Replay short-circuit (FIX 1, PR #106 critical): match on
  //    (intent_id, idempotency_key) — NOT intent_id alone. Matching on
  //    intent_id alone would short-circuit any new attempt (whose key
  //    differs by `attempt`), making per-attempt retries unreachable for
  //    any intent that ever produced a terminal row.
  const priorRows = (await sql`
    SELECT id, status, response_payload, error_message
    FROM cc_actions_log
    WHERE intent_id = ${intent.id}::uuid
      AND idempotency_key = ${idempotencyKey}
      AND status IN ('completed', 'failed')
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    status: string;
    response_payload: Record<string, unknown> | null;
    error_message: string | null;
  }>;
  if (priorRows[0]) {
    const prior = priorRows[0];
    return {
      ok: prior.status === 'completed',
      idempotencyKey,
      actionLogId: String(prior.id),
      data: prior.response_payload ?? undefined,
      error: prior.error_message ?? undefined,
      replayed: true,
    };
  }

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
      // FIX 2 (PR #106 critical): replayed:true tells executeIntent's
      // `!result.replayed` guard to skip its own failIntent — dispatch has
      // already written the audit row + transitioned status.
      return { ok: false, idempotencyKey, error: errMsg, replayed: true };
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
      // FIX 2 (PR #106 critical): replayed:true tells executeIntent's
      // `!result.replayed` guard to skip its own failIntent.
      return {
        ok: false,
        idempotencyKey,
        actionLogId: auditId,
        error: refusal,
        replayed: true,
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
