/**
 * Executor registry — shared types.
 *
 * Canonical URI per intent_type:
 *   chittycanon://core/services/chittycommand/executors/{intent_type}
 *
 * Per ADR-001 amendment (PR-A): the executor registry is the canonical home
 * for action-execution logic. ActionAgent (chat surface) and the
 * meta-orchestrator daemon loop (autonomous surface) are siblings consuming
 * this registry; neither dispatches the other.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../../src/index';
import type { Intent, SovereigntyAssessmentSnapshot } from '../intent';

/**
 * Re-reckon window. If `intent.sovereigntyAssessment.assessedAt` is older
 * than this at executor entry, dispatch() re-runs the gate.
 */
export const SOVEREIGNTY_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

export interface ExecutorContext {
  env: Env;
  sql: NeonQueryFunction<false, false>;
  intent: Intent;
  /** The assessment snapshot in force at execution time (possibly re-reckoned). */
  sovereignty: SovereigntyAssessmentSnapshot;
  attempt: number;
  idempotencyKey: string;
}

export interface ExecutorResult {
  ok: boolean;
  /** Idempotency key used / would have been used. Always set. */
  idempotencyKey: string;
  /** The cc_actions_log row id created (or replayed). */
  actionLogId?: string;
  /** Free-form executor payload returned to caller. */
  data?: Record<string, unknown>;
  error?: string;
  /** True iff the result was replayed from a prior cc_actions_log row. */
  replayed?: boolean;
  /**
   * True iff the outcome is indeterminate — money MAY have moved but the
   * result is unknown (Mercury 409 collision, network/lost-response, 5xx, or an
   * unparseable 2xx). The audit row is left `in_flight` and `executeIntent`
   * MUST NOT mark the intent `failed`, so the next dispatch pass reaches the
   * `in_flight_unknown` reconciliation branch instead of burying it as failed.
   */
  indeterminate?: boolean;
}

export interface IntentExecutor {
  /** Canonical intent_type this executor handles. */
  intentType: string;
  /** Canonical URI for the executor (for audit / discovery). */
  canonicalUri: string;
  /**
   * Execute the intent. MUST NOT write the cc_actions_log audit row — that is
   * the dispatcher's responsibility (so attempt + idempotency_key + intent_id
   * are populated consistently across all executors). The executor MAY write
   * domain-specific side effects and return a description / payload that the
   * dispatcher folds into the audit row.
   */
  run(ctx: ExecutorContext): Promise<ExecutorRunOutput>;
}

export interface ExecutorRunOutput {
  ok: boolean;
  /** Short audit description, e.g. "obligation X: pending -> paid". */
  description: string;
  /** action_type for cc_actions_log (e.g., 'status_change', 'payment'). */
  actionType: string;
  /** target_type for cc_actions_log (e.g., 'obligation', 'dispute'). */
  targetType: string;
  /** target_id for cc_actions_log (nullable). */
  targetId?: string | null;
  /** status for cc_actions_log row. `in_progress` and `pending_review` are
   *  used by the money-path executor when Mercury returns 2xx but the
   *  transaction has not yet cleared (`pending`) or needs human review
   *  (`requires_review`) — see meta/executors/mercury-payment.ts. */
  status:
    | 'completed'
    | 'failed'
    | 'pending_approval'
    | 'in_progress'
    | 'pending_review'
    | 'in_flight';
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set by money-path executors when `ok: false` AND money may have moved
   * (status === 'in_flight'). The dispatcher propagates this onto
   * ExecutorResult so executeIntent skips failIntent and the row stays
   * `in_flight` for operator reconciliation. See mercury-payment.ts.
   */
  indeterminate?: boolean;
}
