/**
 * Workspace Studio HTTP endpoints — Roux Ingest custom step.
 *
 * chittycommand IS the Workspace Add-on backend (HTTP-mode add-ons are GA;
 * no Apps Script project). Google's Workspace Studio invokes these endpoints
 * directly when a workflow author drops the "Roux Ingest" custom step into
 * a Gmail-triggered routine.
 *
 *   POST /workspace/studio/roux-ingest/config   — render config card
 *   POST /workspace/studio/roux-ingest/execute  — run the step
 *
 * Both endpoints expect the standard Workspace HTTP payload with an
 * `authorizationEventObject` containing systemIdToken / userIdToken /
 * userOAuthToken — verified by the workspaceAuth middleware.
 *
 * Response shape: literal JSON matching the Google Apps Card v1 / RenderActions
 * proto. We do NOT use Apps Script SDK methods (setLog, TextFormatChip, etc.)
 * because this is HTTP mode.
 *   ref: https://developers.google.com/workspace/add-ons/concepts/http-overview
 *
 * @canon: chittycanon://core/services/chittycommand/workspace-studio
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { workspaceAuth, type WorkspaceVariables } from '../middleware/workspace-auth';
import {
  verifyRegisteredChannel,
  WORKSPACE_STUDIO_CHANNEL_ID,
} from '../lib/channel-registry';
import { createIntent, createGoal, createPlan } from '../../meta/intent';
import { deriveRouxFromType } from '../lib/dispute-sync';
import { getDb } from '../lib/db';
import { evidenceClient, routerClient } from '../lib/integrations';

export const workspaceStudioRoutes = new Hono<{
  Bindings: Env;
  Variables: WorkspaceVariables;
}>();

// ── Config card ─────────────────────────────────────────────────────────
// Returned to Workspace Studio when a workflow author opens the custom step
// settings. Single-card limitation: no nav, no multi-step.
workspaceStudioRoutes.post('/config', async (c) => {
  // Config endpoint does not require user auth — the workflow author is
  // already authenticated to Workspace. Google still sends a system token,
  // but we don't gate the config preview on it.
  return c.json({
    renderActions: {
      action: {
        navigations: [
          {
            pushCard: {
              sections: [
                {
                  header: 'ChittyCommand — Roux Ingest',
                  widgets: [
                    {
                      textParagraph: {
                        text:
                          'Routes the triggering Gmail message into ChittyCommand as a triage intent. ' +
                          'ChittyRoux derives privilege (privileged/pii/hoa_evidentiary/public) and ' +
                          'space (business/legalink) from message classification and applies the gate.',
                      },
                    },
                    {
                      textInput: {
                        name: 'chittycommand_url',
                        label: 'ChittyCommand endpoint',
                        value: 'https://command.chitty.cc',
                      },
                    },
                    {
                      textInput: {
                        name: 'default_privilege',
                        label: 'Default privilege if classification fails',
                        value: 'public',
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  });
});

// ── Execute step ────────────────────────────────────────────────────────

workspaceStudioRoutes.post('/execute', workspaceAuth(), async (c) => {
  const body = c.get('workspaceBody') as Record<string, unknown>;
  const wsCtx = c.get('workspaceContext');

  // Channel registration check.
  const channelId =
    extractScalar(body, 'channel_id') ??
    extractInputScalar(body, 'channel_id') ??
    WORKSPACE_STUDIO_CHANNEL_ID;
  const channel = await verifyRegisteredChannel(channelId, c.env);
  if (!channel) {
    return c.json(
      stepError('CHANNEL_NOT_REGISTERED', `Channel ${channelId} is not registered`, 'NOT_RETRYABLE'),
      403,
    );
  }

  // Defensive input parsing — accept both Apps-Script-style nested shape and
  // a flat shape. Workspace HTTP-mode shape isn't fully documented; both are
  // observed in the wild.
  const messageId = extractInputScalar(body, 'message_id') ?? extractScalar(body, 'message_id');
  const subject = extractInputScalar(body, 'subject') ?? extractScalar(body, 'subject') ?? '';
  const from = extractInputScalar(body, 'from') ?? extractScalar(body, 'from') ?? '';
  const disputeType =
    extractInputScalar(body, 'dispute_type') ?? extractScalar(body, 'dispute_type') ?? 'public';
  const classification =
    extractInputScalar(body, 'classification') ?? extractScalar(body, 'classification') ?? '';
  const attachmentIds = extractInputList(body, 'attachment_ids') ?? extractList(body, 'attachment_ids') ?? [];
  const driveFolder = extractInputScalar(body, 'drive_folder_url') ?? extractScalar(body, 'drive_folder_url');
  const sheetRow = extractInputScalar(body, 'sheet_row_url') ?? extractScalar(body, 'sheet_row_url');

  if (!messageId) {
    return c.json(
      stepError('MISSING_INPUT', 'message_id is required', 'NOT_RETRYABLE'),
      400,
    );
  }

  // Idempotency by Gmail message_id.
  const idempotencyKey = c.req.header('Idempotency-Key') ?? `gmail-${messageId}`;
  const sql = getDb(c.env);
  const existing = await sql`
    SELECT id, privilege, space, payload
    FROM cc_intents
    WHERE payload->'source'->>'message_id' = ${messageId}
      AND intent_type = 'roux_ingest'
    LIMIT 1
  `;
  if (existing[0]) {
    const row = existing[0] as { id: string; privilege: string; space: string; payload: Record<string, unknown> };
    return c.json(
      stepSuccess({
        intent_id: row.id,
        privilege: row.privilege,
        space: row.space,
        gate_outcome: (row.payload?.gate_outcome as string) ?? 'unknown',
        content_hashes: ((row.payload?.content_hashes as string[]) ?? []),
        idempotent_hit: true,
        idempotency_key: idempotencyKey,
        triage_url: `https://command.chitty.cc/triage/${row.id}`,
      }),
    );
  }

  // Roux derivation — combines dispute_type and classification.
  const roux = deriveRouxFromType(classification || disputeType);
  const gateOutcome =
    roux.privilege === 'privileged' || roux.privilege === 'pii' || roux.space === 'legalink'
      ? 'suppressed'
      : 'mirrored';

  // Create the goal/plan/intent chain. The intent is the durable artifact.
  const ownerChittyId = wsCtx.user_email; // user email is acceptable as owner anchor for now
  let intentId: string;
  try {
    const goal = await createGoal(c.env, {
      ownerChittyId,
      title: `roux_ingest: ${subject || messageId}`,
      description: `Workspace Studio ingest from ${from}`,
      priority: 5,
      metadata: { source: 'workspace_studio', channel_id: channel.channel_id },
    });
    const plan = await createPlan(c.env, {
      goalId: goal.id,
      title: `Ingest Gmail message ${messageId}`,
      authoredBy: 'workspace-studio',
    });
    const intent = await createIntent(c.env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'roux_ingest',
      targetChannel: channel.channel_id,
      privilege: roux.privilege,
      space: roux.space,
      payload: {
        source: {
          channel: 'gmail',
          message_id: messageId,
          subject,
          from,
        },
        classification,
        dispute_type: disputeType,
        attachment_ids: attachmentIds,
        drive_folder_url: driveFolder ?? null,
        sheet_row_url: sheetRow ?? null,
        gate_outcome: gateOutcome,
        content_hashes: [] as string[],
      },
      metadata: {
        user_email: wsCtx.user_email,
        idempotency_key: idempotencyKey,
      },
    });
    intentId = intent.id;
  } catch (err) {
    return c.json(
      stepError(
        'INTENT_CREATE_FAILED',
        `createIntent failed: ${err instanceof Error ? err.message : String(err)}`,
        'RETRYABLE',
      ),
      500,
    );
  }

  // Fan-out — fire-and-forget via waitUntil so we stay under the 30s ceiling.
  const ctx = c.executionCtx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    for (const attId of attachmentIds) {
      ctx.waitUntil(ingestAttachment(c.env, intentId, attId, wsCtx.user_oauth_token));
    }
    ctx.waitUntil(
      recordCustodyIfPrivileged(c.env, intentId, roux, {
        message_id: messageId,
        user_email: wsCtx.user_email,
      }),
    );
    ctx.waitUntil(
      classifySecondPass(c.env, intentId, {
        title: subject || messageId,
        dispute_type: disputeType,
        description: classification,
      }),
    );
  }

  return c.json(
    stepSuccess({
      intent_id: intentId,
      privilege: roux.privilege,
      space: roux.space,
      gate_outcome: gateOutcome,
      content_hashes: [] as string[],
      idempotent_hit: false,
      idempotency_key: idempotencyKey,
      triage_url: `https://command.chitty.cc/triage/${intentId}`,
      drive_folder_url: driveFolder ?? null,
      sheet_row_url: sheetRow ?? null,
    }),
  );
});

// ── Async fan-out helpers ────────────────────────────────────────────────

async function ingestAttachment(
  env: Env,
  intentId: string,
  attachmentId: string,
  userOAuthToken: string | null,
): Promise<void> {
  try {
    if (!env.SVC_STORAGE) return;
    const res = await env.SVC_STORAGE.fetch('https://storage.internal/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Service': 'chittycommand',
        'X-Intent-Id': intentId,
      },
      body: JSON.stringify({
        source: 'gmail',
        attachment_id: attachmentId,
        user_oauth_token: userOAuthToken,
        intent_id: intentId,
      }),
    });
    if (!res.ok) {
      console.error(`[ws-studio] storage_ingest failed for ${attachmentId}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[ws-studio] storage_ingest exception for ${attachmentId}:`, err);
  }
}

async function recordCustodyIfPrivileged(
  env: Env,
  intentId: string,
  roux: { privilege: string; space: string },
  ctx: { message_id: string; user_email: string },
): Promise<void> {
  if (roux.privilege !== 'privileged' && roux.space !== 'legalink') return;
  try {
    const ev = evidenceClient(env);
    if (!ev) return;
    await ev.addCustodyEntry(intentId, {
      action: 'ingested_from_gmail',
      performedBy: ctx.user_email,
      location: 'workspace-studio-roux-ingest',
      notes: `gmail message_id=${ctx.message_id}`,
    });
  } catch (err) {
    console.error('[ws-studio] addCustodyEntry failed:', err);
  }
}

async function classifySecondPass(
  env: Env,
  intentId: string,
  payload: { title: string; dispute_type: string; description: string },
): Promise<void> {
  try {
    const rc = routerClient(env);
    if (!rc) return;
    await rc.classifyDispute({
      entity_id: intentId,
      entity_type: 'event',
      title: payload.title,
      dispute_type: payload.dispute_type,
      description: payload.description,
    });
  } catch (err) {
    console.error('[ws-studio] classifyDispute second-pass failed:', err);
  }
}

// ── Output shape helpers ─────────────────────────────────────────────────

interface StepSuccessOutputs {
  intent_id: string;
  privilege: string;
  space: string;
  gate_outcome: string;
  content_hashes: string[];
  idempotent_hit: boolean;
  idempotency_key: string;
  triage_url: string;
  drive_folder_url?: string | null;
  sheet_row_url?: string | null;
}

function stepSuccess(outputs: StepSuccessOutputs) {
  // Workspace Studio expects an output object plus a log/notification block.
  // We surface chip-style links via notifications text (HTTP mode has no
  // TextFormatChip — we inline the URLs and Workspace's HTML renderer
  // autolinks them).
  const links: string[] = [`triage: ${outputs.triage_url}`];
  if (outputs.drive_folder_url) links.push(`drive: ${outputs.drive_folder_url}`);
  if (outputs.sheet_row_url) links.push(`sheet: ${outputs.sheet_row_url}`);
  const logText =
    `intent_id=${outputs.intent_id} privilege=${outputs.privilege} space=${outputs.space} ` +
    `gate=${outputs.gate_outcome} idempotent=${outputs.idempotent_hit ? 'yes' : 'no'}\n` +
    links.join('\n');
  return {
    status: 'SUCCESS',
    outputs,
    renderActions: {
      action: {
        notifications: [{ text: `Roux ingest ok: ${outputs.intent_id}` }],
      },
    },
    log: logText,
  };
}

function stepError(
  code: string,
  message: string,
  retry: 'RETRYABLE' | 'NOT_RETRYABLE',
) {
  return {
    status: 'ACTIONABLE',
    retry,
    error: { code, message },
    renderActions: {
      action: {
        notifications: [{ text: `Roux ingest ${code}: ${message}` }],
      },
    },
    log: `error ${code}: ${message}`,
  };
}

// ── Defensive input extractors ───────────────────────────────────────────

function extractScalar(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v === 'string') return v;
  return null;
}

function extractList(body: Record<string, unknown>, key: string): string[] | null {
  const v = body[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return null;
}

function extractInputScalar(body: Record<string, unknown>, key: string): string | null {
  const workflow = ((body.event as Record<string, unknown>)?.workflow ??
    (body as Record<string, unknown>).workflow) as Record<string, unknown> | undefined;
  const action = (workflow?.actionInvocation as Record<string, unknown>) ?? undefined;
  const inputs = (action?.inputs as Record<string, unknown>) ?? undefined;
  const slot = inputs?.[key] as Record<string, unknown> | undefined;
  if (!slot) return null;
  const sv = slot.stringValues as unknown;
  if (Array.isArray(sv) && typeof sv[0] === 'string') return sv[0];
  if (typeof slot.value === 'string') return slot.value;
  return null;
}

function extractInputList(body: Record<string, unknown>, key: string): string[] | null {
  const workflow = ((body.event as Record<string, unknown>)?.workflow ??
    (body as Record<string, unknown>).workflow) as Record<string, unknown> | undefined;
  const action = (workflow?.actionInvocation as Record<string, unknown>) ?? undefined;
  const inputs = (action?.inputs as Record<string, unknown>) ?? undefined;
  const slot = inputs?.[key] as Record<string, unknown> | undefined;
  if (!slot) return null;
  const sv = slot.stringValues as unknown;
  if (Array.isArray(sv)) return sv.filter((x): x is string => typeof x === 'string');
  return null;
}
