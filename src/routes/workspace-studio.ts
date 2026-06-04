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
import { createGoal, createPlan, createRouxIngestIntentIdempotent } from '../../meta/intent';
import { deriveRouxFromType, mergeRouxClassification } from '../lib/dispute-sync';
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
  //
  // Pre-check via SELECT is a TOCTOU race — two concurrent Google retries can
  // both pass before either INSERT lands. The atomic guard is the partial
  // unique index `cc_intents_roux_ingest_message_id_uidx` (migration 0017)
  // combined with `INSERT ... ON CONFLICT DO NOTHING` on the createIntent
  // call below. The SELECT here is a fast-path for the common case (sequential
  // retry) — if it hits, we return the existing row without re-running
  // createGoal/createPlan/createIntent at all.
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

  // Roux derivation — derive from BOTH classification and dispute_type, then
  // take the MORE sensitive of the two. Prior code used `classification ||
  // disputeType` which let a "public" classification mask a privileged
  // dispute_type (e.g. "legal"). Take strictest privilege AND strictest space
  // independently — see mergeRouxClassification.
  const rouxFromClassification = deriveRouxFromType(classification);
  const rouxFromDisputeType = deriveRouxFromType(disputeType);
  const roux = mergeRouxClassification(rouxFromClassification, rouxFromDisputeType);
  const gateOutcome =
    roux.privilege === 'privileged' || roux.privilege === 'pii' || roux.space === 'legalink'
      ? 'suppressed'
      : 'mirrored';

  // Create the goal/plan/intent chain. The intent is the durable artifact.
  // Intent creation is idempotent on Gmail message_id (atomic ON CONFLICT
  // against the partial unique index in migration 0017). If two concurrent
  // Google retries reach this point, exactly one wins the INSERT; the loser
  // re-SELECTs and gets the winner's intent_id. The goal/plan rows from the
  // losing race are orphaned but harmless.
  const ownerChittyId = wsCtx.user_email; // user email is acceptable as owner anchor for now
  let intentId: string;
  let idempotentHitFromRace = false;
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
    const result = await createRouxIngestIntentIdempotent(c.env, {
      planId: plan.id,
      goalId: goal.id,
      intentType: 'roux_ingest',
      targetChannel: channel.channel_id,
      privilege: roux.privilege,
      space: roux.space,
      messageId,
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
    intentId = result.intent.id;
    idempotentHitFromRace = !result.created;
  } catch (err) {
    console.error('[ws-studio] createIntent failed:', err);
    return c.json(
      stepError(
        'INTENT_CREATE_FAILED',
        'Failed to create triage intent. Please retry.',
        'RETRYABLE',
      ),
      500,
    );
  }

  // Fan-out — fire-and-forget via waitUntil so we stay under the 30s ceiling.
  // Skip when we lost the idempotency race; the winner already kicked off
  // fanout.
  const ctx = c.executionCtx;
  if (ctx && typeof ctx.waitUntil === 'function' && !idempotentHitFromRace) {
    for (const attId of attachmentIds) {
      ctx.waitUntil(
        ingestAttachment(c.env, intentId, attId, messageId, wsCtx.user_oauth_token),
      );
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
      idempotent_hit: idempotentHitFromRace,
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
  gmailMessageId: string,
  userOAuthToken: string | null,
): Promise<void> {
  try {
    if (!env.SVC_STORAGE) return;
    // Gmail attachments API: users.messages.attachments.get requires BOTH
    // messageId and attachment id
    // (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get).
    // Forward gmail_message_id alongside attachment_id so chittystorage can
    // hit the Gmail API path when the file isn't already in Drive.
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
        gmail_message_id: gmailMessageId,
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

// Workspace Studio output contract:
// https://developers.google.com/workspace/add-ons/studio/output-variables
// The execute step must wrap outputs in
//   hostAppAction.workflowAction.returnOutputVariablesAction.outputVariables[]
// for downstream Studio steps to see them. Errors mirror the matrix with
// returnElementErrorAction.
function stepSuccess(outputs: StepSuccessOutputs) {
  const outputVariables = Object.entries(outputs)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => ({ name, value }));
  const links: string[] = [`triage: ${outputs.triage_url}`];
  if (outputs.drive_folder_url) links.push(`drive: ${outputs.drive_folder_url}`);
  if (outputs.sheet_row_url) links.push(`sheet: ${outputs.sheet_row_url}`);
  const logText =
    `intent_id=${outputs.intent_id} privilege=${outputs.privilege} space=${outputs.space} ` +
    `gate=${outputs.gate_outcome} idempotent=${outputs.idempotent_hit ? 'yes' : 'no'}\n` +
    links.join('\n');
  return {
    hostAppAction: {
      workflowAction: {
        returnOutputVariablesAction: {
          outputVariables,
          log: { text: logText },
        },
      },
    },
    // Keep the bare `outputs` field as a non-breaking shim for any internal
    // consumer / test that already reads it. Studio itself reads from
    // hostAppAction.workflowAction.returnOutputVariablesAction.
    outputs,
    status: 'SUCCESS',
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
  // Workspace Studio error matrix: returnElementErrorAction with explicit
  // actionability + retryability + an error log entry.
  return {
    hostAppAction: {
      workflowAction: {
        returnElementErrorAction: {
          errorActionability: 'ACTIONABLE',
          errorRetryability: retry,
          errorLog: { text: `error ${code}: ${message}` },
          errorMessage: { text: message },
          errorCode: code,
        },
      },
    },
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
