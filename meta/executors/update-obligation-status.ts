/**
 * Executor: update_obligation_status
 *
 * Canonical URI: chittycanon://core/services/chittycommand/executors/update_obligation_status
 *
 * Updates the status of a cc_obligations row and folds the change into the
 * row's metadata for audit. DB-only, no external side effects — safe for
 * autonomous execution from the meta-orchestrator AND from ActionAgent chat.
 *
 * The audit row in cc_actions_log is written by the dispatcher (with
 * intent_id, attempt, idempotency_key populated). This file emits only the
 * domain effect and returns the audit summary.
 */

import { z } from 'zod';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { ExecutorContext, ExecutorRunOutput, IntentExecutor } from './types';
import { registerExecutor } from './registry';

export const UPDATE_OBLIGATION_STATUS_INTENT = 'update_obligation_status';

export const updateObligationStatusSchema = z.object({
  obligation_id: z.string().uuid().describe('Obligation ID to update'),
  status: z.enum(['pending', 'paid', 'overdue', 'deferred']).describe('New status'),
  notes: z.string().optional().describe('Reason for status change'),
});

export type UpdateObligationStatusArgs = z.infer<typeof updateObligationStatusSchema>;

/**
 * Pure runner — used by both ActionAgent (chat surface) and the dispatcher
 * (autonomous surface). Does NOT write cc_actions_log; returns a structured
 * result the caller folds into its own audit row.
 */
export async function runUpdateObligationStatus(
  args: UpdateObligationStatusArgs,
  sql: NeonQueryFunction<false, false>,
): Promise<{
  success: boolean;
  payee?: string;
  old_status?: string;
  new_status?: string;
  error?: string;
}> {
  const { obligation_id, status, notes } = args;
  const [existing] = await sql`
    SELECT id, payee, status as old_status
    FROM cc_obligations
    WHERE id = ${obligation_id}::uuid`;
  if (!existing) return { success: false, error: 'Obligation not found' };

  await sql`
    UPDATE cc_obligations
    SET status = ${status}, updated_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          status_change: {
            from: existing.old_status,
            to: status,
            notes: notes ?? null,
            date: new Date().toISOString(),
          },
        })}::jsonb
    WHERE id = ${obligation_id}::uuid`;

  return {
    success: true,
    payee: String(existing.payee ?? ''),
    old_status: String(existing.old_status ?? ''),
    new_status: status,
  };
}

const executor: IntentExecutor = {
  intentType: UPDATE_OBLIGATION_STATUS_INTENT,
  canonicalUri:
    'chittycanon://core/services/chittycommand/executors/update_obligation_status',
  async run(ctx: ExecutorContext): Promise<ExecutorRunOutput> {
    const parsed = updateObligationStatusSchema.safeParse(ctx.intent.payload);
    if (!parsed.success) {
      return {
        ok: false,
        description: `payload validation failed for intent ${ctx.intent.id}`,
        actionType: 'status_change',
        targetType: 'obligation',
        targetId: null,
        status: 'failed',
        errorMessage: parsed.error.message,
      };
    }
    const result = await runUpdateObligationStatus(parsed.data, ctx.sql);
    if (!result.success) {
      return {
        ok: false,
        description: result.error ?? 'unknown failure',
        actionType: 'status_change',
        targetType: 'obligation',
        targetId: parsed.data.obligation_id,
        status: 'failed',
        errorMessage: result.error ?? 'unknown failure',
      };
    }
    const notesSuffix = parsed.data.notes ? ` (${parsed.data.notes})` : '';
    return {
      ok: true,
      description: `${result.payee}: ${result.old_status} → ${result.new_status}${notesSuffix}`,
      actionType: 'status_change',
      targetType: 'obligation',
      targetId: parsed.data.obligation_id,
      status: 'completed',
      responsePayload: { ...result },
    };
  },
};

registerExecutor(executor);

export default executor;
