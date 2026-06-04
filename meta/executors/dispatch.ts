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
 *
 * Formula: sha256("{intent.id}:{intent.intentType}")
 *
 * The key is deterministic on `intent.id` (NOT `attempt`) so that:
 *   1. The partial unique index on `cc_actions_log (intent_id, idempotency_key)`
 *      prevents duplicate audit rows across daemon retries — every retry of
 *      the same intent reuses the same key and the index rejects the second
 *      INSERT.
 *   2. Mercury de-dupes on the same value end-to-end — a retry after a Neon
 *      blip cannot cause double-spend because Mercury sees the same key.
 *   3. The pre-write in_flight row uses this key, and a successful run
 *      UPDATEs that same row in place (see writePreAudit / updateAuditRow).
 */
async function computeIdempotencyKey(
  intentId: string,
  intentType: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${intentId}:${intentType}`);
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
  const idempotencyKey = await computeIdempotencyKey(intent.id, intent.intentType);

  // 1. Replay / safety lookup. With the key deterministic on intent_id, every
  //    prior row for this intent shares the same idempotency_key. We look up
  //    by (intent_id, idempotency_key) regardless of status because:
  //      - 'completed' / 'failed' / 'pending_review' / 'in_progress' →
  //        terminal-or-known; short-circuit and replay the prior outcome.
  //      - 'in_flight' → the previous attempt's outcome is UNKNOWN. Mercury
  //        may or may not have moved money. We MUST NOT re-call Mercury.
  //        Refuse with `in_flight_unknown`; the operator runbook resolves by
  //        querying Mercury directly using this idempotency key and then
  //        manually setting the row to its true terminal state.
  const priorRows = (await sql`
    SELECT id, status, response_payload, error_message, idempotency_key, attempt
    FROM cc_actions_log
    WHERE intent_id = ${intent.id}::uuid
      AND idempotency_key = ${idempotencyKey}
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
    if (prior.status === 'in_flight') {
      const errMsg =
        `prior attempt is in_flight (audit_log id=${prior.id}, idempotency_key=${idempotencyKey}) — ` +
        `Mercury state is unknown; operator must reconcile before retry`;
      console.error(`[meta/executors/dispatch] in_flight_unknown for intent ${intent.id}: ${errMsg}`);
      return {
        ok: false,
        idempotencyKey,
        actionLogId: prior.id,
        error: errMsg,
        replayed: true,
      };
    }
    // Any other status → known terminal outcome, replay it.
    return {
      ok: prior.status === 'completed',
      idempotencyKey,
      actionLogId: prior.id,
      data: prior.response_payload ?? undefined,
      error: prior.error_message ?? undefined,
      replayed: true,
    };
  }

  // 2. Compute attempt number. With the deterministic key, `attempt` is now
  //    purely audit metadata (the unique partial index dedupes us, not the
  //    attempt number). Still useful for operators inspecting retry history.
  const [{ count: priorCount } = { count: 0 }] = (await sql`
    SELECT COUNT(*)::int AS count FROM cc_actions_log WHERE intent_id = ${intent.id}::uuid
  `) as unknown as Array<{ count: number }>;
  const attempt = (priorCount ?? 0) + 1;

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
      await safeFailIntent(env, intent.id, errMsg);
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
      await safeFailIntent(env, intent.id, refusal);
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

  // 5. PRE-WRITE the audit row as `in_flight` BEFORE invoking the executor.
  //    This is the atomicity guarantee for the money path: if the executor
  //    moves money and the post-update fails (e.g., Neon outage), the
  //    in_flight row still exists and a retry will see it via the prior-row
  //    lookup above and refuse with `in_flight_unknown`. The operator runbook
  //    then reconciles by querying Mercury with `idempotencyKey`.
  //
  //    The partial unique index on (intent_id, idempotency_key) prevents two
  //    concurrent dispatchers from racing to create the same in_flight row —
  //    the second INSERT will fail with a unique violation. We let that throw
  //    so the daemon's outer loop treats it as a retryable error.
  let auditId: string;
  try {
    auditId = await writeAuditRow(sql, {
      intentId: intent.id,
      attempt,
      idempotencyKey,
      actionType: 'payment_in_flight',
      targetType: 'intent',
      targetId: intent.id,
      description: `mercury_payment in_flight for intent ${intent.id}`,
      status: 'in_flight',
      errorMessage: null,
      responsePayload: null,
      requestPayload: intent.payload,
      metadata: { sovereignty, canonicalUri: executor.canonicalUri, phase: 'pre_execute' },
    });
  } catch (err) {
    // Pre-write failed — money has NOT moved. Surface to caller; daemon
    // retries with backoff. failIntent is NOT called (the intent stays
    // claimable on the next pass).
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[meta/executors/dispatch] pre-write audit failed for intent ${intent.id}: ${errMsg}`);
    throw new Error(`audit_write_failed_pre_execute: ${errMsg}`);
  }

  // 6. Execute.
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
    // Executor threw — update the in_flight row to failed (NOT a new row;
    // same idempotency key, same record). If the update itself throws, we
    // surface to the daemon so the row remains `in_flight` and a retry will
    // hit the `in_flight_unknown` branch.
    try {
      await updateAuditRow(sql, auditId, {
        actionType: 'executor_error',
        description: `executor threw: ${errMsg}`,
        status: 'failed',
        errorMessage: errMsg,
        responsePayload: null,
        metadata: { sovereignty, canonicalUri: executor.canonicalUri, phase: 'executor_threw' },
      });
    } catch (updateErr) {
      const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      console.error(
        `[meta/executors/dispatch] AUDIT_UPDATE_FAILED_AFTER_EXECUTOR_THREW intent=${intent.id} key=${idempotencyKey}: ${updateMsg}`,
      );
      throw new Error(
        `audit_update_failed_after_executor_threw: original=${errMsg}; update_error=${updateMsg}`,
      );
    }
    return { ok: false, idempotencyKey, actionLogId: auditId, error: errMsg };
  }

  // 7. UPDATE the same audit row in place with the executor result. This is
  //    the atomicity completion: in_flight → terminal status. Failure here
  //    leaves the row in_flight, which a retry will treat as
  //    `in_flight_unknown` (safe — Mercury de-dupes on idempotencyKey, so
  //    operator reconciliation reveals the true state).
  try {
    await updateAuditRow(sql, auditId, {
      actionType: runOutput.actionType,
      description: runOutput.description,
      status: runOutput.status,
      errorMessage: runOutput.errorMessage ?? null,
      responsePayload: runOutput.responsePayload ?? null,
      metadata: {
        sovereignty,
        canonicalUri: executor.canonicalUri,
        phase: 'post_execute',
        ...(runOutput.metadata ?? {}),
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[meta/executors/dispatch] AUDIT_UPDATE_FAILED_POST_EXECUTE intent=${intent.id} key=${idempotencyKey} executor_ok=${runOutput.ok}: ${errMsg}`,
    );
    // Surface to daemon — the row is still in_flight, so a retry will be
    // refused as in_flight_unknown (correct, since money may have moved).
    throw new Error(
      `audit_update_failed_post_execute: executor_ok=${runOutput.ok}; update_error=${errMsg}`,
    );
  }

  return {
    ok: runOutput.ok,
    idempotencyKey,
    actionLogId: auditId,
    data: runOutput.responsePayload,
    error: runOutput.errorMessage,
  };
}

/**
 * failIntent wrapper that, if failIntent itself throws (e.g., Neon outage),
 * (a) logs to console.error with a stable token for operator alerting and
 * (b) re-throws so the daemon's outer loop catches and applies backoff.
 * Replaces the prior `.catch(() => null)` pattern which silently dropped
 * failure information.
 */
async function safeFailIntent(env: Env, intentId: string, reason: string): Promise<void> {
  try {
    await failIntent(env, intentId, reason);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Stable token so log aggregators / Alchemist alerting can match.
    console.error(
      `[meta/executors/dispatch] audit_write_failed_during_failIntent intent=${intentId} reason="${reason}" error=${errMsg}`,
    );
    throw new Error(`failIntent_threw: intent=${intentId}: ${errMsg}`);
  }
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

interface AuditUpdate {
  actionType: string;
  description: string;
  status: string;
  errorMessage: string | null;
  responsePayload: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

/**
 * UPDATE an existing audit row by id. Used to transition the in_flight
 * placeholder into its terminal status after the executor returns. We
 * intentionally do NOT touch intent_id / attempt / idempotency_key /
 * request_payload — those were set at pre-write and are immutable.
 */
async function updateAuditRow(
  sql: NeonQueryFunction<false, false>,
  id: string,
  patch: AuditUpdate,
): Promise<void> {
  await sql`
    UPDATE cc_actions_log
    SET action_type = ${patch.actionType},
        description = ${patch.description},
        status = ${patch.status},
        error_message = ${patch.errorMessage},
        response_payload = ${patch.responsePayload ? JSON.stringify(patch.responsePayload) : null}::jsonb,
        metadata = ${JSON.stringify(patch.metadata)}::jsonb
    WHERE id = ${id}::uuid
  `;
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
