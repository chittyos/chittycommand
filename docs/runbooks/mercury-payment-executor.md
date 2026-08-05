---
canonicalUri: chittycanon://docs/runbooks/chittycommand/mercury-payment-executor
service: chittycommand
component: meta/executors/mercury-payment
risk: real-money
---

# Mercury Payment Executor — Operator Runbook

**REAL MONEY PATH.** This runbook covers the autonomous-execution path for
Mercury ACH payments via the meta-orchestrator. The executor lives at
`meta/executors/mercury-payment.ts` and is dispatched by
`meta/executors/dispatch.ts` when a `mercury_payment` intent reaches the
daemon loop.

Refer to ADR-001 (and its amendment) at
`docs/architecture/ADR-001-meta-orchestrator-extension.md` for the
architectural context.

## What the executor refuses

The executor refuses (writes a `payment_refusal` row to `cc_actions_log`
and does NOT call Mercury) in any of these cases:

| Refusal reason            | Trigger                                                                 |
|---------------------------|-------------------------------------------------------------------------|
| `sovereignty_not_autonomous` | `sovereignty_assessment.decision !== 'autonomous'`                  |
| `sovereignty_stale`       | snapshot `assessedAt` older than 60s at executor entry                  |
| `amount_cap_exceeded`     | `payload.amount_cents > MERCURY_AUTONOMOUS_AMOUNT_CAP_USD * 100`        |
| `invalid_payload`         | zod schema rejected the payload                                         |
| `missing_token`           | `mercury:token:{account_slug}` is absent from `COMMAND_KV`              |
| `mercury_api_failure`     | Mercury HTTP call returned null (5xx, timeout, network)                 |

Successful executions write a `payment` row with `status='completed'`.

## Sovereignty configuration

The executor requires:

1. The sovereignty assessment on the intent (set by `createIntent` or
   computed by dispatch's re-reckon) MUST have `decision: 'autonomous'`.
   `requires_human` and any blocked state both refuse this money-path
   executor — even `requires_human` is treated as a refusal here.
2. The snapshot's `assessedAt` MUST be within
   `MERCURY_SOVEREIGNTY_FRESHNESS_MS` (60 seconds). Tighter than the
   default 5 minutes for non-money paths.

The daemon / orchestrator that invokes `executeIntent` for a
`mercury_payment` intent SHOULD pass:

```ts
import { MERCURY_SOVEREIGNTY_FRESHNESS_MS } from '../meta/executors/mercury-payment';

await executeIntent(env, intentId, {
  actorChittyId: ownerChittyId,
  freshnessMs: MERCURY_SOVEREIGNTY_FRESHNESS_MS,
});
```

This forces the dispatcher to re-reckon against `trust.chitty.cc` if the
snapshot on the intent is older than 60s. The executor's own freshness
check is a belt-and-suspenders safety net for that same window.

To allow an autonomous `mercury_payment`, the owner ChittyID must currently
hold a sovereignty assessment producing `decision: 'autonomous'` from
`assessSovereignty()` in `meta/sovereignty.ts`. Trust score thresholds
and policy logic live in ChittyTrust; consult that service to understand
why a particular actor is or is not autonomous for this intent type.

## Amount cap configuration

The cap is set via the Worker secret/var
`MERCURY_AUTONOMOUS_AMOUNT_CAP_USD` (whole USD, string). Default is 500
USD if unset.

```bash
# Set to USD 250
npx wrangler secret put MERCURY_AUTONOMOUS_AMOUNT_CAP_USD
# (enter 250 at prompt)
```

Any single intent with `amount_cents > cap * 100` is refused with reason
`amount_cap_exceeded`. There is no batching path that bypasses this — to
move a larger amount autonomously, you would need to increase the cap
(and accept the corresponding risk), or split the obligation into
multiple intents each under the cap.

## How to manually approve a `requires_human` mercury_payment

When sovereignty produces `requires_human` for a mercury_payment intent:

1. The dispatcher writes a `sovereignty_refusal` row to `cc_actions_log`
   (or the executor writes `payment_refusal` if dispatch's freshness
   window was longer than 60s and let the snapshot through).
2. The intent status moves to `failed`. The current build does NOT
   auto-create a parallel approval queue entry; manual approval requires:
   a. Inspecting the refusal via the dashboard or
      `SELECT ... FROM cc_actions_log WHERE intent_id = '<id>'`.
   b. Performing the payment via the ActionAgent chat surface
      (`execute_payment` tool), which routes through the same pure
      runner but supplies an `autonomous` + fresh snapshot because the
      human typing in chat IS the approval event. The chat path writes
      its own `cc_actions_log` row without `intent_id`.
   c. Then manually updating the failed intent's metadata to reference
      the chat-executed `cc_actions_log.id` for audit linkage:
      ```sql
      UPDATE cc_intents
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'manually_approved_via_chat', '<chat_actions_log_id>',
        'approved_by', '<chitty_id>',
        'approved_at', NOW()::text
      )
      WHERE id = '<intent_id>';
      ```

A dedicated dashboard approval flow is a follow-up (tracked in the
ADR-001 amendment notes).

## Rollback / cancellation

To refuse or cancel a queued `mercury_payment` intent BEFORE the daemon
dispatches it:

```sql
UPDATE cc_intents
SET status = 'failed',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'cancelled_by', '<chitty_id>',
      'cancelled_at', NOW()::text,
      'cancel_reason', '<reason>'
    )
WHERE id = '<intent_id>' AND status = 'pending';
```

`executeIntent` only acts on `status = 'pending'` intents (it atomically
claims via `UPDATE ... RETURNING`), so a status change to `failed`
prevents dispatch.

After the daemon has already called `executeIntent` and the Mercury API
returned success: the payment is in flight at Mercury. Cancellation must
go through Mercury's dashboard or API directly — the local
`cc_actions_log` row is audit-only and reversing it does not unwind a
real ACH transfer.

## Audit query

To inspect every payment-related action for a given intent:

```sql
SELECT
  id,
  intent_id,
  attempt,
  idempotency_key,
  action_type,
  target_type,
  target_id,
  description,
  status,
  error_message,
  request_payload,
  response_payload,
  metadata,
  executed_at
FROM cc_actions_log
WHERE action_type IN ('payment', 'payment_refusal')
  AND intent_id = '<intent_id>'::uuid
ORDER BY executed_at ASC;
```

For a recipient-level audit:

```sql
SELECT id, intent_id, status, description, executed_at
FROM cc_actions_log
WHERE action_type IN ('payment', 'payment_refusal')
  AND target_id = '<recipient_id>'
ORDER BY executed_at DESC
LIMIT 50;
```

For the chat surface (no `intent_id`):

```sql
SELECT id, status, description, metadata, executed_at
FROM cc_actions_log
WHERE action_type = 'payment'
  AND intent_id IS NULL
ORDER BY executed_at DESC
LIMIT 50;
```

## Idempotency

The dispatcher computes a deterministic idempotency key per attempt:

```
sha256("{intent.id}:{attempt}:{intent_type}")
```

The partial unique index
`cc_actions_log (intent_id, idempotency_key) WHERE intent_id IS NOT NULL
AND idempotency_key IS NOT NULL` enforces single-row-per-attempt at the
database level. The dispatcher also short-circuits on any prior terminal
(`completed` or `failed`) row for the same `intent_id`, so a replay of a
finished intent returns the prior result without re-executing.

The Mercury API call passes `ctx.idempotencyKey` as Mercury's own
`idempotencyKey`, so Mercury de-dupes on the same value if the executor
is re-invoked between writing the audit row and Mercury responding.

## Related files

- `meta/executors/mercury-payment.ts` — executor + pure runner
- `meta/executors/dispatch.ts` — dispatcher (sovereignty re-reckon, audit write)
- `meta/sovereignty.ts` — sovereignty gate (calls trust.chitty.cc)
- `src/agents/tools/actions.ts` — chat surface (`execute_payment` tool)
- `src/lib/integrations.ts` — Mercury API client (`mercuryClient`)
- `tests/meta/executors/mercury-payment.spec.ts` — refusal-path integration tests
