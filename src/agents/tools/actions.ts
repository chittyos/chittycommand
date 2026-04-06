import { tool } from 'ai';
import { z } from 'zod';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../../index';
import { mercuryClient } from '../../lib/integrations';

/**
 * Create action execution tools bound to environment and SQL.
 *
 * These tools perform WRITE operations — paying bills, sending emails,
 * updating obligation statuses. Every action is logged to cc_actions_log.
 */
export function createActionTools(env: Env, sql: NeonQueryFunction<false, false>) {
  return {
    execute_payment: tool({
      description: 'Execute a payment via Mercury Banking. Requires explicit user approval. Creates an ACH transfer from a Mercury account to a saved recipient. The payment is logged and the linked obligation is updated.',
      inputSchema: z.object({
        account_slug: z.string().describe('Mercury org slug (e.g., "aribia-llc", "aribia-mgmt")'),
        mercury_account_id: z.string().describe('Mercury account ID to pay from'),
        recipient_id: z.string().describe('Mercury recipient ID to pay'),
        amount: z.number().positive().describe('Payment amount in USD'),
        note: z.string().optional().describe('Payment memo/note'),
        obligation_id: z.string().uuid().optional().describe('Link payment to this obligation'),
      }),
      execute: async ({ account_slug, mercury_account_id, recipient_id, amount, note, obligation_id }) => {
        // Get Mercury token from KV
        const token = await env.COMMAND_KV.get(`mercury:token:${account_slug}`);
        if (!token) {
          return { success: false, error: `No Mercury token for org "${account_slug}". Run token refresh first.` };
        }

        const mercury = mercuryClient(token);
        const idempotencyKey = crypto.randomUUID();

        const result = await mercury.createPayment(mercury_account_id, {
          recipientId: recipient_id,
          amount,
          paymentMethod: 'ach',
          idempotencyKey,
          note: note || undefined,
        });

        if (!result) {
          // Log failed attempt
          await sql`
            INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
            VALUES ('payment', 'obligation', ${obligation_id || null},
                    ${`Mercury ACH $${amount.toFixed(2)} to ${recipient_id} — FAILED`}, 'failed',
                    ${JSON.stringify({ account_slug, mercury_account_id, recipient_id, amount, idempotencyKey })}::jsonb)
          `;
          return { success: false, error: 'Mercury API rejected the payment. Check logs for details.' };
        }

        // Log successful payment
        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
          VALUES ('payment', 'obligation', ${obligation_id || null},
                  ${`Mercury ACH $${amount.toFixed(2)} — tx ${result.id}`}, 'completed',
                  ${JSON.stringify({ ...result, account_slug, idempotencyKey })}::jsonb)
        `;

        // Update obligation if linked
        if (obligation_id) {
          await sql`
            UPDATE cc_obligations
            SET status = 'paid', updated_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
                  last_payment: { amount, mercury_tx_id: result.id, date: new Date().toISOString() },
                })}::jsonb
            WHERE id = ${obligation_id}::uuid
          `;
        }

        return { success: true, transaction_id: result.id, amount, status: result.status };
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
      inputSchema: z.object({
        obligation_id: z.string().uuid().describe('Obligation ID to update'),
        status: z.enum(['pending', 'paid', 'overdue', 'deferred']).describe('New status'),
        notes: z.string().optional().describe('Reason for status change'),
      }),
      execute: async ({ obligation_id, status, notes }) => {
        const [existing] = await sql`SELECT id, payee, status as old_status FROM cc_obligations WHERE id = ${obligation_id}::uuid`;
        if (!existing) return { success: false, error: 'Obligation not found' };

        await sql`
          UPDATE cc_obligations
          SET status = ${status}, updated_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
                status_change: { from: existing.old_status, to: status, notes, date: new Date().toISOString() },
              })}::jsonb
          WHERE id = ${obligation_id}::uuid
        `;

        await sql`
          INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status)
          VALUES ('status_change', 'obligation', ${obligation_id},
                  ${`${existing.payee}: ${existing.old_status} → ${status}${notes ? ` (${notes})` : ''}`}, 'completed')
        `;

        return { success: true, payee: existing.payee, old_status: existing.old_status, new_status: status };
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
