/**
 * dispute-sync.ts
 *
 * Coordinator for ChittyDisputes ↔ Notion ↔ TriageAgent sync.
 *
 * Three public entry points:
 *   - fireDisputeSideEffects   (called by POST /api/disputes)
 *   - reconcileNotionDisputes  (called by daily cron Phase 10)
 *   - pushUnlinkedDisputesToNotion (called by bridge route)
 *
 * Loop prevention: metadata->>'notion_task_id' on disputes,
 *                  metadata->>'dispute_id' on tasks.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';
import { notionClient, routerClient, ledgerClient } from './integrations';


// ── Types ─────────────────────────────────────────────────────

interface DisputeCore {
  id: string;
  title: string;
  counterparty: string;
  dispute_type: string;
  amount_at_stake?: number | null;
  description?: string | null;
  priority: number;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  privilege?: 'privileged' | 'pii' | 'hoa_evidentiary' | 'public' | null;
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  space?: 'business' | 'legalink' | null;
  metadata?: Record<string, unknown> | null;
}

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
export type RouxPrivilege = 'privileged' | 'pii' | 'hoa_evidentiary' | 'public';
export type RouxSpace = 'business' | 'legalink';

// Strictness ordering — higher = more sensitive. Used by mergeRouxClassification
// to take the more sensitive of two derived roux candidates.
const PRIVILEGE_RANK: Record<RouxPrivilege, number> = {
  public: 0,
  hoa_evidentiary: 1,
  pii: 2,
  privileged: 3,
};
const SPACE_RANK: Record<RouxSpace, number> = {
  business: 0,
  legalink: 1,
};

/**
 * Pick the MORE sensitive of two Roux classifications. Privilege and space are
 * compared independently — e.g. (public, legalink) merged with (privileged,
 * business) yields (privileged, legalink). This prevents an upstream "public"
 * classification from masking a caller-supplied "legal" dispute_type.
 *
 * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
 */
export function mergeRouxClassification(
  a: { privilege: RouxPrivilege; space: RouxSpace },
  b: { privilege: RouxPrivilege; space: RouxSpace },
): { privilege: RouxPrivilege; space: RouxSpace } {
  return {
    privilege: PRIVILEGE_RANK[a.privilege] >= PRIVILEGE_RANK[b.privilege] ? a.privilege : b.privilege,
    space: SPACE_RANK[a.space] >= SPACE_RANK[b.space] ? a.space : b.space,
  };
}

// Map a cc_disputes.dispute_type to default Roux (privilege, space).
// Explicit caller-supplied values always override (Q1=(c) pass-through derive).
export function deriveRouxFromType(disputeType: string): {
  privilege: RouxPrivilege;
  space: RouxSpace;
} {
  // Fail-safe routing: dispute_type is free-text from the API/UI. Any string
  // containing "legal" routes to privileged/legalink (prevents leakage of
  // "Legal", "legal dispute", etc. to the public/business Notion bucket).
  // Any string containing "insurance" routes to pii/business. This is
  // intentionally over-broad on the privileged side — better to over-suppress
  // a Notion mirror than to leak privileged content.
  const normalized = (disputeType ?? '').toLowerCase().trim();
  if (normalized.includes('legal')) {
    return { privilege: 'privileged', space: 'legalink' };
  }
  if (normalized.includes('insurance')) {
    return { privilege: 'pii', space: 'business' };
  }
  switch (normalized) {
    case 'property':
    case 'vendor':
    case 'tenant':
    case 'financial':
      return { privilege: 'public', space: 'business' };
    default:
      // Unknown dispute_type — fall back to the safest defaults that still
      // route through the public/business bucket so the dispute is visible.
      return { privilege: 'public', space: 'business' };
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Called immediately after INSERT into cc_disputes.
 * Runs side effects in parallel: Notion task, TriageAgent, Ledger case.
 * None blocks HTTP response — caller wraps in waitUntil().
 */
export async function fireDisputeSideEffects(
  dispute: DisputeCore,
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<void> {
  const meta = (dispute.metadata || {}) as Record<string, unknown>;
  const tasks: Promise<void>[] = [];

  // Notion task — skip if already linked (loop guard)
  if (!meta.notion_task_id) {
    tasks.push(linkDisputeToNotion(dispute.id, dispute, env, sql).then(() => {}));
  }

  // TriageAgent scoring — always runs
  tasks.push(scoreDisputeWithTriage(dispute.id, dispute, env, sql));

  // ChittyLedger case — skip if already linked
  if (!meta.ledger_case_id) {
    tasks.push(linkDisputeToLedger(dispute.id, dispute, env, sql));
  }

  await Promise.allSettled(tasks);
}

/**
 * Cron Phase 10: find cc_tasks with task_type='legal' not yet linked
 * to a dispute and auto-create cc_disputes rows.
 */
export async function reconcileNotionDisputes(
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<number> {
  const legalTasks = await sql`
    SELECT id, title, description, priority, due_date, notion_page_id, metadata
    FROM cc_tasks
    WHERE task_type = 'legal'
      AND backend_status NOT IN ('done', 'verified')
      AND (metadata->>'dispute_id') IS NULL
    ORDER BY priority ASC, created_at ASC
    LIMIT 50
  `;

  let created = 0;

  for (const task of legalTasks) {
    const taskId = task.id as string;
    const notionPageId = task.notion_page_id as string | null;

    // Skip tasks without a Notion origin — prevents loop where we'd create a
    // Notion page that syncs back as a new task on the next cron run
    if (!notionPageId) continue;

    try {
      // Check if a dispute already exists with this notion_task_id
      if (notionPageId) {
        const [existing] = await sql`
          SELECT id FROM cc_disputes
          WHERE metadata->>'notion_task_id' = ${notionPageId}
          LIMIT 1
        `;
        if (existing) {
          // Link task back and skip
          await sql`
            UPDATE cc_tasks
            SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ dispute_id: existing.id })}::jsonb,
                updated_at = NOW()
            WHERE id = ${taskId}
          `;
          continue;
        }
      }

      // Create dispute with notion_task_id pre-set (suppresses Notion write in side effects)
      const disputeMeta: Record<string, unknown> = {
        notion_task_id: notionPageId,
        source: 'notion_task',
        source_task_id: taskId,
      };

      const [dispute] = await sql`
        INSERT INTO cc_disputes (title, counterparty, dispute_type, priority, description, metadata)
        VALUES (
          ${task.title as string},
          'Unknown',
          'legal',
          ${(task.priority as number) || 5},
          ${(task.description as string | null) || null},
          ${JSON.stringify(disputeMeta)}::jsonb
        )
        RETURNING id, title, counterparty, dispute_type, priority, description, metadata
      `;

      // Link task back (loop guard for future cron runs)
      await sql`
        UPDATE cc_tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ dispute_id: dispute.id })}::jsonb,
            updated_at = NOW()
        WHERE id = ${taskId}
      `;

      await sql`
        INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
        VALUES (
          'dispute_auto_created', 'dispute', ${dispute.id as string},
          ${'Auto-created from Notion legal task: ' + (task.title as string)},
          'completed',
          ${JSON.stringify({ source_task_id: taskId, notion_page_id: notionPageId })}::jsonb
        )
      `;

      // TriageAgent + Ledger (Notion write suppressed by notion_task_id in metadata)
      await fireDisputeSideEffects(
        {
          id: dispute.id as string,
          title: dispute.title as string,
          counterparty: dispute.counterparty as string,
          dispute_type: dispute.dispute_type as string,
          priority: dispute.priority as number,
          description: dispute.description as string | null,
          metadata: dispute.metadata as Record<string, unknown>,
        },
        env,
        sql,
      );

      created++;
    } catch (err) {
      console.error(`[dispute-sync:reconcile] Failed for task ${taskId}:`, err);
    }
  }

  return created;
}

/**
 * Bridge trigger: push disputes without a Notion task link to Notion.
 * Idempotent — safe to call repeatedly.
 */
export async function pushUnlinkedDisputesToNotion(
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<number> {
  const unlinked = await sql`
    SELECT id, title, counterparty, dispute_type, priority, description, metadata,
           privilege, space
    FROM cc_disputes
    WHERE (metadata->>'notion_task_id') IS NULL
      AND status NOT IN ('resolved', 'dismissed')
    ORDER BY created_at ASC
    LIMIT 50
  `;

  let pushed = 0;

  for (const dispute of unlinked) {
    try {
      // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
      // Q2=(a) pass-through-with-warn: rows that landed on the column defaults
      // (public/business) may be untagged legacy rows (the DB stores defaults
      // even when the caller didn't supply explicit values). For the Notion-gate
      // decision, we cannot distinguish "caller explicitly chose public/business"
      // from "caller omitted both fields and PG defaulted them". When both axes
      // sit on the defaults, re-derive from dispute_type so a row with
      // dispute_type='legal' is still suppressed even though privilege/space
      // were stored as public/business. The DB row itself is left untouched —
      // an explicit retag is a separate concern.
      const storedPrivilege = (dispute.privilege as string | null) ?? 'public';
      const storedSpace = (dispute.space as string | null) ?? 'business';
      const onDefaults = storedPrivilege === 'public' && storedSpace === 'business';
      let gateDispute = dispute as unknown as DisputeCore;
      if (onDefaults) {
        console.log(
          `[dispute-sync:roux-backfill] dispute_id=${dispute.id} on default privilege=public space=business — re-deriving from dispute_type=${dispute.dispute_type as string} for gate decision; explicit tag recommended`,
        );
        const derived = deriveRouxFromType(dispute.dispute_type as string);
        gateDispute = {
          ...(dispute as unknown as DisputeCore),
          privilege: derived.privilege,
          space: derived.space,
        };
      }
      const linked = await linkDisputeToNotion(dispute.id as string, gateDispute, env, sql);
      if (linked) pushed++;
    } catch (err) {
      console.error(`[dispute-sync:push] Failed for dispute ${dispute.id}:`, err);
    }
  }

  return pushed;
}

// ── Internal helpers ──────────────────────────────────────────

export async function linkDisputeToNotion(
  disputeId: string,
  dispute: Pick<DisputeCore, 'title' | 'dispute_type' | 'priority' | 'description' | 'privilege' | 'space'>,
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<boolean> {
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  // Roux gate: privileged/pii content and anything in the legalink space must
  // NOT be mirrored into Notion. Resolve effective values: explicit > derived.
  const derived = deriveRouxFromType(dispute.dispute_type);
  const effectivePrivilege = dispute.privilege ?? derived.privilege;
  const effectiveSpace = dispute.space ?? derived.space;
  if (
    effectivePrivilege === 'privileged' ||
    effectivePrivilege === 'pii' ||
    effectiveSpace === 'legalink'
  ) {
    console.log(
      `[dispute-sync:notion] suppressed (privilege=${effectivePrivilege} space=${effectiveSpace}) dispute=${disputeId}`,
    );
    return false;
  }

  try {
    const notion = notionClient(env);
    if (!notion) {
      console.warn('[dispute-sync:notion] notionClient unavailable');
      return false;
    }

    const page = await notion.createTask({
      title: dispute.title,
      description: dispute.description || undefined,
      task_type: 'legal',
      priority: dispute.priority,
      source: 'chittycommand_dispute',
      tags: [dispute.dispute_type],
    });

    if (!page?.page_id) {
      console.warn(`[dispute-sync:notion] createTask returned null for dispute ${disputeId}`);
      return false;
    }

    await sql`
      UPDATE cc_disputes
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ notion_task_id: page.page_id, notion_url: page.url })}::jsonb,
          updated_at = NOW()
      WHERE id = ${disputeId}
    `;

    console.log(`[dispute-sync:notion] Linked dispute ${disputeId} → Notion page ${page.page_id}`);
    return true;
  } catch (err) {
    console.error(`[dispute-sync:notion] Failed for dispute ${disputeId}:`, err);
    return false;
  }
}

async function scoreDisputeWithTriage(
  disputeId: string,
  dispute: Pick<DisputeCore, 'title' | 'dispute_type' | 'amount_at_stake' | 'description'>,
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<void> {
  try {
    const router = routerClient(env);
    if (!router) {
      console.warn('[dispute-sync:triage] routerClient unavailable');
      return;
    }

    const result = await router.classifyDispute({
      entity_id: disputeId,
      entity_type: 'event', // @canon: chittycanon://gov/governance#core-types — disputes are Event (E)
      title: dispute.title,
      dispute_type: dispute.dispute_type,
      amount: dispute.amount_at_stake != null ? Number(dispute.amount_at_stake) : undefined,
      description: dispute.description || undefined,
    });

    if (!result) {
      console.warn(`[dispute-sync:triage] TriageAgent returned null for dispute ${disputeId}`);
      return;
    }

    await sql`
      UPDATE cc_disputes
      SET priority = ${result.priority},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            triage_severity: result.severity,
            triage_priority: result.priority,
            triage_labels: result.labels,
            triage_reasoning: result.reasoning || null,
            triage_at: new Date().toISOString(),
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${disputeId}
    `;

    console.log(`[dispute-sync:triage] Scored dispute ${disputeId}: severity=${result.severity} priority=${result.priority}`);
  } catch (err) {
    console.error(`[dispute-sync:triage] Failed for dispute ${disputeId}:`, err);
  }
}

async function linkDisputeToLedger(
  disputeId: string,
  dispute: Pick<DisputeCore, 'title' | 'description'>,
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<void> {
  try {
    const ledger = ledgerClient(env);
    if (!ledger) {
      console.warn(`[dispute-sync:ledger] Skipping dispute ${disputeId}: ChittyLedger not configured`);
      return;
    }

    const caseRef = `CC-DISPUTE-${disputeId.slice(0, 8)}`;
    const entryResult = await ledger.addEntry({
      entityType: 'audit',
      entityId: caseRef,
      action: 'dispute:created',
      actor: 'chittycommand',
      actorType: 'service',
      metadata: {
        title: dispute.title,
        description: dispute.description,
        caseType: 'CIVIL',
      },
    });

    if (entryResult?.id) {
      await sql`
        UPDATE cc_disputes
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ ledger_case_id: caseRef, ledger_entry_id: entryResult.id })}::jsonb,
            updated_at = NOW()
        WHERE id = ${disputeId}
      `;
      console.log(`[dispute-sync:ledger] Linked dispute ${disputeId} → case ${caseRef} (entry ${entryResult.id})`);
    } else {
      console.error(`[dispute-sync:ledger] addEntry returned no ID for dispute ${disputeId} (caseRef: ${caseRef})`);
    }
  } catch (err) {
    console.error(`[dispute-sync:ledger] Failed for dispute ${disputeId}:`, err);
  }
}
