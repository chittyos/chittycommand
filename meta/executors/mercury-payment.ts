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
 *      as `sha256("{intent.id}:{attempt}:{intent_type}")` and passes it via
 *      `ctx.idempotencyKey`. Because `intent.id` is immutable and `attempt`
 *      is derived deterministically from prior `cc_actions_log` rows, a
 *      replay of the same intent reuses the same key — functionally
 *      equivalent to a payload-derived key for replay protection. The
 *      Mercury API call itself uses `ctx.idempotencyKey` as the Mercury
 *      `idempotencyKey`, so Mercury also de-dupes on the same value.
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
import { mercuryClient } from '../../src/lib/integrations';
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
  refusalReason?:
    | 'sovereignty_stale'
    | 'sovereignty_not_autonomous'
    | 'amount_cap_exceeded'
    | 'invalid_payload'
    | 'missing_token'
    | 'mercury_api_failure';
  errorMessage?: string;
}

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
}): Promise<MercuryPaymentRunResult> {
  const { env, payload, sovereignty, idempotencyKey } = args;
  const now = args.now ?? Date.now();

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

  const token = await env.COMMAND_KV.get(`mercury:token:${payload.account_slug}`);
  if (!token) {
    return {
      ok: false,
      refusalReason: 'missing_token',
      errorMessage: `no Mercury token in KV for account_slug='${payload.account_slug}'`,
    };
  }

  const mercury = mercuryClient(token);
  const amountUsd = payload.amount_cents / 100;
  const result = await mercury.createPayment(payload.mercury_account_id, {
    recipientId: payload.recipient_id,
    amount: amountUsd,
    paymentMethod: 'ach',
    idempotencyKey,
    note: payload.memo,
  });

  if (!result) {
    return {
      ok: false,
      refusalReason: 'mercury_api_failure',
      errorMessage: 'Mercury API returned null (HTTP error or network failure)',
    };
  }

  return {
    ok: true,
    transactionId: result.id,
    mercuryStatus: result.status,
  };
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
      return {
        ok: false,
        description: `mercury_payment refused: ${reason}`,
        actionType: 'payment_refusal',
        targetType: 'recipient',
        targetId,
        status: 'failed',
        errorMessage: run.errorMessage ?? reason,
        responsePayload,
        metadata: { refusal_reason: reason },
      };
    }

    return {
      ok: true,
      description: `mercury_payment: USD ${(payload.amount_cents / 100).toFixed(2)} to recipient ${payload.recipient_id} (tx ${run.transactionId})`,
      actionType: 'payment',
      targetType: 'recipient',
      targetId,
      status: 'completed',
      responsePayload,
      metadata: { mercury_status: run.mercuryStatus },
    };
  },
};

registerExecutor(executor);

export default executor;
