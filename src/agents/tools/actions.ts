import { tool } from 'ai';
import { z } from 'zod';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../../index';
import { mercuryClient } from '../../lib/integrations';
// Canonical executors (registry-backed). ActionAgent's chat tools here wrap
// the same pure runners the meta-orchestrator dispatcher invokes — sibling
// surfaces, shared implementation. See ADR-001 amendment (PR-A).
import {
  updateObligationStatusSchema,
  runUpdateObligationStatus,
} from '../../../meta/executors/update-obligation-status';

/**
 * Create action execution tools bound to environment and SQL.
 *
 * These tools perform WRITE operations — paying bills, sending emails,
 * updating obligation statuses. Every action is logged to cc_actions_log.
 */
export function createActionTools(env: Env, sql: NeonQueryFunction<false, false>) {
  return {
    execute_payment: tool({
      description:
        'REFUSED in chat surface. Mercury payments must be initiated from the dashboard, where the authenticated user identity drives a real sovereignty assessment against trust.chitty.cc. The chat tool factory has no access to the chat actor ChittyID, so a real assessSovereignty() call cannot be made — and the prior synthetic `{ decision: "autonomous" }` snapshot was a silent bypass of the gate that protects the real-money path. Use the dashboard payments page instead.',
      inputSchema: z.object({
        account_slug: z.string().optional(),
        mercury_account_id: z.string().optional(),
        recipient_id: z.string().optional(),
        amount: z.number().positive().optional(),
        note: z.string().optional(),
        obligation_id: z.string().uuid().optional(),
      }),
      execute: async ({ account_slug, recipient_id, amount, obligation_id }) => {
        // Audit the refusal so attempted chat-initiated payments are visible
        // to operators (signal: a model tried to move money from chat).
        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
          VALUES ('payment_refusal', 'obligation', ${obligation_id || null},
                  ${`Mercury payment refused in chat surface (use dashboard): ${account_slug ?? '?'} -> ${recipient_id ?? '?'} $${(amount ?? 0).toFixed(2)}`},
                  'failed',
                  ${JSON.stringify({
                    refusal_reason: 'chat_surface_refuses_mercury',
                    surface: 'chat',
                    account_slug: account_slug ?? null,
                    recipient_id: recipient_id ?? null,
                    amount: amount ?? null,
                  })}::jsonb)
        `;
        return {
          success: false,
          error:
            'Mercury payments cannot be initiated from chat. Use the dashboard payments page — it has the authenticated chat actor identity needed for a real sovereignty assessment against trust.chitty.cc. This refusal is by design: a synthetic "autonomous" snapshot in chat would silently bypass the money-path sovereignty gate.',
          refusal_reason: 'chat_surface_refuses_mercury',
        };
      },
    }),

    list_mercury_recipients: tool({
      description: 'List saved payment recipients for a Mercury account. Use this to find recipient IDs before executing a payment.',
      inputSchema: z.object({
        account_slug: z.string().describe('Mercury org slug'),
        mercury_account_id: z.string().describe('Mercury account ID'),
      }),
      execute: async ({ account_slug, mercury_account_id }) => {
        const token = await env.COMMAND_KV.get(`mercury:token:${account_slug}`);
        if (!token) return { error: `No Mercury token for org "${account_slug}"` };

        const mercury = mercuryClient(token);
        const result = await mercury.getRecipients(mercury_account_id);
        if (!result) return { error: 'Failed to fetch recipients from Mercury' };

        return { recipients: result.recipients, count: result.recipients.length };
      },
    }),

    update_obligation_status: tool({
      description: 'Update the status of an obligation (bill). Use after confirming a payment was made or to defer a bill.',
      inputSchema: updateObligationStatusSchema,
      execute: async (args) => {
        // Delegates to the canonical executor's pure runner so chat + autonomous
        // surfaces share the same implementation. The chat path still writes its
        // own cc_actions_log row (without intent_id) so the existing chat audit
        // trail behavior is preserved exactly.
        const result = await runUpdateObligationStatus(args, sql);
        if (!result.success) return result;
        const notesSuffix = args.notes ? ` (${args.notes})` : '';
        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status)
          VALUES ('status_change', 'obligation', ${args.obligation_id},
                  ${`${result.payee}: ${result.old_status} → ${result.new_status}${notesSuffix}`}, 'completed')
        `;
        return result;
      },
    }),

    send_dispute_email: tool({
      description: 'Draft and queue a dispute letter/email. The email is saved to cc_dispute_correspondence and queued for sending. Requires user approval of the draft before sending.',
      inputSchema: z.object({
        dispute_id: z.string().uuid().describe('Dispute ID this email relates to'),
        to_email: z.string().email().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body text'),
        correspondence_type: z.enum(['demand_letter', 'follow_up', 'response', 'settlement_offer', 'complaint']).describe('Type of correspondence'),
      }),
      execute: async ({ dispute_id, to_email, subject, body, correspondence_type }) => {
        // Verify dispute exists
        const [dispute] = await sql`SELECT id, title, counterparty FROM cc_disputes WHERE id = ${dispute_id}::uuid`;
        if (!dispute) return { success: false, error: 'Dispute not found' };

        // Save to correspondence log as draft
        const [correspondence] = await sql`
          INSERT INTO cc_dispute_correspondence
            (dispute_id, direction, channel, subject, content, metadata)
          VALUES (
            ${dispute_id}::uuid, 'outbound', 'email', ${subject}, ${body},
            ${JSON.stringify({ to_email, correspondence_type, drafted_by: 'action_agent', status: 'draft' })}::jsonb
          )
          RETURNING id
        `;

        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status)
          VALUES ('email_draft', 'dispute', ${dispute_id},
                  ${`Draft ${correspondence_type} to ${to_email}: "${subject}"`}, 'pending_approval')
        `;

        return {
          success: true,
          correspondence_id: correspondence.id,
          status: 'draft',
          message: 'Email drafted and saved. User must approve before sending.',
          dispute_title: dispute.title,
        };
      },
    }),

    get_action_log: tool({
      description: 'View recent actions taken by the agent — payments, status changes, emails sent.',
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional().describe('Number of results (default 20)'),
        action_type: z.string().optional().describe('Filter by type: payment, status_change, email_draft, recommendation_acted'),
      }),
      execute: async ({ limit, action_type }) => {
        const n = limit ?? 20;
        if (action_type) {
          const rows = await sql`
            SELECT id, action_type, target_type, target_id, description, status, created_at
            FROM cc_actions_log
            WHERE action_type = ${action_type}
            ORDER BY executed_at DESC LIMIT ${n}
          `;
          return { actions: rows, count: rows.length };
        }
        const rows = await sql`
          SELECT id, action_type, target_type, target_id, description, status, executed_at
          FROM cc_actions_log
          ORDER BY executed_at DESC LIMIT ${n}
        `;
        return { actions: rows, count: rows.length };
      },
    }),
  };
}
