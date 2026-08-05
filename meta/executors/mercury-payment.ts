/**
 * Executor: mercury_payment
 *
 * Canonical URI: chittycanon://core/services/chittycommand/executors/mercury_payment
 *
 * REAL-MONEY PATH. Higher constraint bar than other executors:
 *
 *   1. Sovereignty must be `autonomous` AND the snapshot in ctx must be at most
 *      MERCURY_SOVEREIGNTY_FRESHNESS_MS old at executor entry (60s — tighter
 *      than the default 5min). This is belt-and-suspenders: the daemon /
 *      orchestrator that calls `executeIntent` SHOULD also pass
 *      `freshnessMs: MERCURY_SOVEREIGNTY_FRESHNESS_MS` so the dispatcher
 *      re-reckons against trust.chitty.cc first. The executor refusing here
 *      is the second gate, not the only gate.
 *   2. Amount cap: any single intent with `amount_cents > cap` is refused.
 *      Cap is `env.MERCURY_AUTONOMOUS_AMOUNT_CAP_USD` (whole-dollar string),
 *      default 500. Higher amounts must be routed through the dashboard
 *      human-approval path; they are NOT autonomous-executable here.
 *   3. Idempotency: the unique partial index on
 *      `cc_actions_log (intent_id, idempotency_key) WHERE intent_id IS NOT
 *      NULL AND idempotency_key IS NOT NULL` prevents double-execute. The
 *      dispatcher (meta/executors/dispatch.ts) computes the idempotency key
 *      as `sha256("{intent.id}:{intent_type}")` — DETERMINISTIC on intent.id,
 *      with NO `attempt` component. This is load-bearing: every retry of the
 *      same intent MUST reuse the same key so Mercury de-dupes end-to-end and
 *      a retry after a Neon blip cannot double-spend. Do NOT add `attempt` to
 *      this formula — a per-attempt key defeats Mercury's dedup and is a
 *      double-spend vector. The Mercury API call passes `ctx.idempotencyKey`
 *      as the `Idempotency-Key` header.
 *   4. NEVER log raw API keys, account numbers, routing numbers, or PII.
 *      `responsePayload` carries `transaction_id`, `status`, `amount`,
 *      `recipient_id`, last-4 only when available. `requestPayload` (set by
 *      dispatcher from `intent.payload`) only contains the intent payload
 *      shape — no token or routing data.
 *
 * The cc_actions_log audit row is written by the dispatcher (with
 * `intent_id`, `attempt`, `idempotency_key` populated). This file emits
 * only the domain effect (the Mercury API call) and returns the audit
 * summary the dispatcher folds into the row.
 *
 * Sibling chat surface: `src/agents/tools/actions.ts::execute_payment`
 * delegates to `runMercuryPayment` here so chat + autonomous paths share
 * the same implementation. See ADR-001 amendment (PR-A).
 *
 * @canonical-uri chittycanon://core/services/chittycommand/executors/mercury_payment
 */

import { z } from 'zod';
import type { Env } from '../../src/index';
import { mercuryClient, type FetchImpl } from '../../src/lib/integrations';
import type { ExecutorContext, ExecutorRunOutput, IntentExecutor } from './types';
import { registerExecutor } from './registry';

export const MERCURY_PAYMENT_INTENT = 'mercury_payment';

/**
 * Money-path freshness window (60s). Tighter than the default 5min in
 * `SOVEREIGNTY_FRESHNESS_MS`. Callers of `executeIntent` for this
 * intent_type SHOULD pass this as `freshnessMs` so the dispatcher re-reckons
 * sovereignty before invoking the executor; the executor's own check below
 * is a safety net.
 */
export const MERCURY_SOVEREIGNTY_FRESHNESS_MS = 60_000;

/** Default cap if env.MERCURY_AUTONOMOUS_AMOUNT_CAP_USD is unset. */
const DEFAULT_AMOUNT_CAP_USD = 500;

export const mercuryPaymentPayloadSchema = z.object({
  account_slug: z
    .string()
    .min(1)
    .describe('Mercury org slug (e.g., "aribia-llc") for KV token lookup'),
  mercury_account_id: z.string().min(1).describe('Mercury account to debit'),
  recipient_id: z.string().min(1).describe('Mercury recipient ID'),
  amount_cents: z
    .number()
    .int()
    .positive()
    .describe('Payment amount in USD cents'),
  currency: z.literal('USD'),
  memo: z.string().max(280).optional(),
  obligation_id: z.string().uuid().optional(),
  recipient_account_last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Last-4 of recipient account for audit (optional, opaque otherwise)'),
});

export type MercuryPaymentPayload = z.infer<typeof mercuryPaymentPayloadSchema>;

export interface MercuryPaymentRunResult {
  ok: boolean;
  transactionId?: string;
  mercuryStatus?: string;
  /** Mapped cc_actions_log status — only set when the Mercury call returned
   *  HTTP 2xx and a parseable body. Mirrors Mercury's status field through
   *  our audit vocabulary. */
  auditStatus?: 'completed' | 'in_progress' | 'pending_review' | 'failed';
  refusalReason?:
    | 'sovereignty_stale'
    | 'sovereignty_not_autonomous'
    | 'amount_cap_exceeded'
    | 'invalid_payload'
    | 'missing_token'
    | 'invalid_account_slug'
    | 'mercury_api_failure'
    | 'mercury_internal_failure'
    | 'idempotency_collision';
  errorMessage?: string;
  /** HTTP status from Mercury (success or failure) — for audit visibility. */
  httpStatus?: number;
  /** First 500 chars of Mercury's response body — never contains tokens. */
  bodySnippet?: string;
  /** Failure kind from the discriminated MercuryPostResult, when ok=false. */
  failureKind?: 'network' | 'http' | 'parse' | 'idempotency_collision';
  /**
   * True iff money MAY have moved but the outcome is unknown — Mercury 409
   * collision (the original payment under this key likely already went out),
   * network/lost-response, a 5xx, or an unparseable 2xx body. The dispatcher
   * records the audit row as `in_flight` (NOT `failed`) so it triggers the
   * `in_flight_unknown` operator reconciliation path. A definite 4xx rejection
   * (≠409) and an explicit Mercury `status:"failed"` are NOT indeterminate —
   * no money moved, so they stay terminal `failed`.
   */
  indeterminate?: boolean;
}

/** Allowed account_slug pattern: lowercase alnum + hyphens only. */
const ACCOUNT_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Pure runner — shared by ActionAgent chat tool (`execute_payment`) and the
 * executor below. Does NOT write `cc_actions_log`. Returns a structured
 * result the caller folds into its own audit trail.
 *
 * Refusal semantics:
 *   - `sovereignty.decision !== 'autonomous'` → refusal, no Mercury call.
 *   - sovereignty snapshot older than `MERCURY_SOVEREIGNTY_FRESHNESS_MS` →
 *     refusal, no Mercury call.
 *   - amount > cap → refusal, no Mercury call.
 *   - Mercury returns null (HTTP error, network) → `mercury_api_failure`.
 */
export async function runMercuryPayment(args: {
  env: Env;
  payload: MercuryPaymentPayload;
  sovereignty: { decision: string; assessedAt: string };
  idempotencyKey: string;
  now?: number;
  /** Test/DI hook: inject a custom fetch so integration tests can drive
   *  network failures and Mercury 2xx-with-error-envelope without mocking
   *  mercuryClient itself. Default is global fetch. */
  fetchImpl?: FetchImpl;
}): Promise<MercuryPaymentRunResult> {
  const { env, payload, sovereignty, idempotencyKey, fetchImpl } = args;
  const now = args.now ?? Date.now();

  // Normalize the account_slug BEFORE any KV lookup. If normalization changes
  // the value, the input was malformed — reject as `invalid_account_slug`
  // rather than silently looking up a different token (which would have its
  // own security implications: a slug "Aribia/../foo" must not silently
  // collapse to "aribia-foo").
  const normalizedSlug = payload.account_slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (
    normalizedSlug !== payload.account_slug ||
    normalizedSlug.length === 0 ||
    !ACCOUNT_SLUG_RE.test(normalizedSlug)
  ) {
    return {
      ok: false,
      refusalReason: 'invalid_account_slug',
      errorMessage: `account_slug='${payload.account_slug}' is malformed (must match ${ACCOUNT_SLUG_RE.source})`,
    };
  }

  if (sovereignty.decision !== 'autonomous') {
    return {
      ok: false,
      refusalReason: 'sovereignty_not_autonomous',
      errorMessage: `sovereignty: requires_human or blocked (decision='${sovereignty.decision}')`,
    };
  }

  const assessedAt = Date.parse(sovereignty.assessedAt);
  if (!Number.isFinite(assessedAt) || now - assessedAt > MERCURY_SOVEREIGNTY_FRESHNESS_MS) {
    return {
      ok: false,
      refusalReason: 'sovereignty_stale',
      errorMessage: `sovereignty snapshot older than ${MERCURY_SOVEREIGNTY_FRESHNESS_MS}ms — re-reckon required for money path`,
    };
  }

  const capUsdRaw = env.MERCURY_AUTONOMOUS_AMOUNT_CAP_USD;
  const capUsd =
    capUsdRaw && !Number.isNaN(Number(capUsdRaw))
      ? Math.floor(Number(capUsdRaw))
      : DEFAULT_AMOUNT_CAP_USD;
  const capCents = capUsd * 100;
  if (payload.amount_cents > capCents) {
    return {
      ok: false,
      refusalReason: 'amount_cap_exceeded',
      errorMessage: `amount ${payload.amount_cents} cents exceeds autonomous cap ${capCents} cents (USD ${capUsd}); requires human approval`,
    };
  }

  const token = await env.COMMAND_KV.get(`mercury:token:${normalizedSlug}`);
  if (!token) {
    return {
      ok: false,
      refusalReason: 'missing_token',
      errorMessage: `no Mercury token in KV for account_slug='${normalizedSlug}'`,
    };
  }

  const mercury = mercuryClient(token, fetchImpl);
  const amountUsd = payload.amount_cents / 100;
  const result = await mercury.createPayment(payload.mercury_account_id, {
    recipientId: payload.recipient_id,
    amount: amountUsd,
    paymentMethod: 'ach',
    idempotencyKey,
    note: payload.memo,
  });

  // Branch on the discriminated union — every failure mode has a distinct
  // refusal reason and lands in the audit row with httpStatus + bodySnippet so
  // operators can diagnose without re-running Mercury.
  if (!result.ok) {
    if (result.kind === 'idempotency_collision') {
      // 409 → a payment under this key was already accepted by Mercury; money
      // very likely moved. Indeterminate → reconcile, do NOT bury as failed.
      return {
        ok: false,
        refusalReason: 'idempotency_collision',
        failureKind: 'idempotency_collision',
        indeterminate: true,
        httpStatus: result.httpStatus,
        bodySnippet: result.bodySnippet,
        errorMessage:
          'Mercury returned 409 idempotency collision — a payment under this idempotency key was already accepted; money may have moved. Reconcile against Mercury before any terminal transition.',
      };
    }
    // "money may have moved" set (chico ruling): network/lost-response, an
    // unparseable 2xx body, and 5xx are all indeterminate — the request may
    // have committed before the response was lost/unreadable. A definite 4xx
    // rejection (≠409: 422 bad recipient, 400 bad amount, 401/403 auth) did
    // NOT move money → terminal `failed`, remediate via a new intent.
    const indeterminate =
      result.kind === 'network' ||
      result.kind === 'parse' ||
      (result.kind === 'http' && (result.httpStatus ?? 0) >= 500);
    return {
      ok: false,
      refusalReason: 'mercury_api_failure',
      failureKind: result.kind,
      indeterminate,
      httpStatus: result.httpStatus,
      bodySnippet: result.bodySnippet,
      errorMessage: `Mercury API ${result.kind} failure${
        result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''
      }${indeterminate ? ' — outcome unknown, money may have moved; reconcile' : ''}: ${result.bodySnippet ?? 'no body'}`,
    };
  }

  // Mercury can return 2xx with a body whose own `status` field indicates
  // failure / pending / review. We MUST NOT blanket-stamp this as `completed`.
  // Map Mercury's status into our audit vocabulary.
  const rawStatus = (result.body.status ?? '').toLowerCase();
  const { auditStatus, refusalReason, errorMessage } = mapMercuryStatus(rawStatus);

  if (refusalReason) {
    return {
      ok: false,
      refusalReason,
      transactionId: result.body.id,
      mercuryStatus: result.body.status,
      auditStatus,
      httpStatus: result.httpStatus,
      bodySnippet: result.rawSnippet,
      errorMessage,
    };
  }

  return {
    ok: true,
    transactionId: result.body.id,
    mercuryStatus: result.body.status,
    auditStatus,
    httpStatus: result.httpStatus,
    bodySnippet: result.rawSnippet,
  };
}

/**
 * Translate Mercury's transaction `status` field into our cc_actions_log
 * `status` vocabulary. Per Mercury docs the status field can be one of:
 *   sent, posted, delivered  →  completed (money actually moved)
 *   pending                  →  in_progress (queued, not yet sent)
 *   failed                   →  failed (rejected by bank / Mercury)
 *   requires_review          →  pending_review (manual approval gate)
 * Unknown values fall through as `in_progress` with a refusal reason so the
 * operator must triage rather than the executor silently treating it as done.
 */
function mapMercuryStatus(rawStatus: string): {
  auditStatus: 'completed' | 'in_progress' | 'pending_review' | 'failed';
  refusalReason?: 'mercury_internal_failure';
  errorMessage?: string;
} {
  switch (rawStatus) {
    case 'sent':
    case 'posted':
    case 'delivered':
      return { auditStatus: 'completed' };
    case 'pending':
      return { auditStatus: 'in_progress' };
    case 'failed':
      return {
        auditStatus: 'failed',
        refusalReason: 'mercury_internal_failure',
        errorMessage: 'Mercury returned 2xx with status="failed" — payment was not accepted',
      };
    case 'requires_review':
      return { auditStatus: 'pending_review' };
    default:
      return {
        auditStatus: 'in_progress',
        refusalReason: 'mercury_internal_failure',
        errorMessage: `Mercury returned 2xx with unrecognized status="${rawStatus}" — refusing to stamp completed`,
      };
  }
}

/**
 * Build a redacted response payload for `cc_actions_log.response_payload`.
 * Never include token, full account number, or routing number.
 */
function buildResponsePayload(
  payload: MercuryPaymentPayload,
  run: MercuryPaymentRunResult,
): Record<string, unknown> {
  return {
    intent_type: MERCURY_PAYMENT_INTENT,
    account_slug: payload.account_slug,
    recipient_id: payload.recipient_id,
    recipient_account_last4: payload.recipient_account_last4 ?? null,
    amount_cents: payload.amount_cents,
    currency: payload.currency,
    transaction_id: run.transactionId ?? null,
    mercury_status: run.mercuryStatus ?? null,
    refusal_reason: run.refusalReason ?? null,
    // Discriminated-error context — present on every Mercury-call failure so
    // operators don't need to re-call Mercury to diagnose.
    failure_kind: run.failureKind ?? null,
    http_status: run.httpStatus ?? null,
    body_snippet: run.bodySnippet ?? null,
  };
}

const executor: IntentExecutor = {
  intentType: MERCURY_PAYMENT_INTENT,
  canonicalUri:
    'chittycanon://core/services/chittycommand/executors/mercury_payment',

  async run(ctx: ExecutorContext): Promise<ExecutorRunOutput> {
    const parsed = mercuryPaymentPayloadSchema.safeParse(ctx.intent.payload);
    if (!parsed.success) {
      return {
        ok: false,
        description: `mercury_payment payload validation failed for intent ${ctx.intent.id}`,
        actionType: 'payment_refusal',
        targetType: 'recipient',
        targetId: null,
        status: 'failed',
        errorMessage: `invalid_payload: ${parsed.error.message}`,
        metadata: { refusal_reason: 'invalid_payload' },
      };
    }
    const payload = parsed.data;

    const run = await runMercuryPayment({
      env: ctx.env,
      payload,
      sovereignty: {
        decision: ctx.sovereignty.decision,
        assessedAt: ctx.sovereignty.assessedAt,
      },
      idempotencyKey: ctx.idempotencyKey,
    });

    const responsePayload = buildResponsePayload(payload, run);
    // target_id is a UUID column in cc_actions_log — we cannot put Mercury's
    // string recipient_id there. Use the linked obligation_id when present
    // (UUID), else null. recipient_id is carried in response_payload and
    // target_type='recipient' so the audit row still indexes the recipient
    // via metadata.
    const targetId = payload.obligation_id ?? null;

    if (!run.ok) {
      const reason = run.refusalReason ?? 'unknown';
      // Indeterminate (money may have moved): leave the row `in_flight` so the
      // next dispatch pass hits `in_flight_unknown` and surfaces a
      // reconciliation signal. Definite refusal / no-money-moved: terminal
      // `failed`. See chico ruling + meta/executors/dispatch.ts in_flight path.
      const indeterminate = run.indeterminate === true;
      return {
        ok: false,
        indeterminate,
        description: indeterminate
          ? `mercury_payment INDETERMINATE: ${reason}${
              run.httpStatus ? ` (HTTP ${run.httpStatus})` : ''
            } — money may have moved; left in_flight for operator reconciliation`
          : `mercury_payment refused: ${reason}${
              run.httpStatus ? ` (HTTP ${run.httpStatus})` : ''
            }`,
        actionType: indeterminate ? 'payment_indeterminate' : 'payment_refusal',
        targetType: 'recipient',
        targetId,
        status: indeterminate ? 'in_flight' : 'failed',
        errorMessage: run.errorMessage ?? reason,
        responsePayload,
        metadata: {
          refusal_reason: reason,
          failure_kind: run.failureKind ?? null,
          http_status: run.httpStatus ?? null,
          indeterminate,
        },
      };
    }

    // Mercury returned 2xx with a status we accept. Use the mapped auditStatus
    // — NEVER blanket-stamp `completed`. `in_progress` (pending) and
    // `pending_review` (requires_review) reach this branch with ok=true.
    const auditStatus = run.auditStatus ?? 'in_progress';
    return {
      ok: true,
      description: `mercury_payment: USD ${(payload.amount_cents / 100).toFixed(
        2,
      )} to recipient ${payload.recipient_id} (tx ${run.transactionId}, mercury_status=${run.mercuryStatus})`,
      actionType: 'payment',
      targetType: 'recipient',
      targetId,
      status: auditStatus,
      responsePayload,
      metadata: {
        mercury_status: run.mercuryStatus,
        http_status: run.httpStatus ?? null,
      },
    };
  },
};

registerExecutor(executor);

export default executor;
