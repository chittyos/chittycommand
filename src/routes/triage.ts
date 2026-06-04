/**
 * ChittyTriage routes — autonomous + human intent triage queue.
 *
 * @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
 *
 * Exposes the cc_intents pending bucket as a triage queue partitioned by the
 * ChittyRoux (privilege, space) axes. Two claim modes:
 *
 *   POST /api/triage/:id/claim       — claim a specific intent by ID
 *   POST /api/triage/claim-next      — bucket-ordered claim (for autonomous
 *                                      agents pulling work)
 *
 * Auth is provided by the global /api/* authMiddleware mount in src/index.ts.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import {
  claimNextIntent,
  completeIntent,
  failIntent,
  type IntentPrivilege,
  type IntentSpace,
} from '../../meta/intent';

export const triageRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const VALID_PRIVILEGE: ReadonlySet<IntentPrivilege> = new Set<IntentPrivilege>([
  'privileged',
  'pii',
  'hoa_evidentiary',
  'public',
]);
const VALID_SPACE: ReadonlySet<IntentSpace> = new Set<IntentSpace>(['business', 'legalink']);

function parsePrivilege(raw: unknown): IntentPrivilege | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return VALID_PRIVILEGE.has(raw as IntentPrivilege) ? (raw as IntentPrivilege) : null;
}

function parseSpace(raw: unknown): IntentSpace | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return VALID_SPACE.has(raw as IntentSpace) ? (raw as IntentSpace) : null;
}

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// GET /api/triage — list pending intents in the queue, optionally filtered
// by privilege/space. Used by the dashboard and human triagers.
triageRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const privilegeQ = c.req.query('privilege');
  const spaceQ = c.req.query('space');
  const limitQ = c.req.query('limit');

  if (privilegeQ && !parsePrivilege(privilegeQ)) {
    return c.json({ error: `Invalid privilege; must be one of ${[...VALID_PRIVILEGE].join(',')}` }, 400);
  }
  if (spaceQ && !parseSpace(spaceQ)) {
    return c.json({ error: `Invalid space; must be one of ${[...VALID_SPACE].join(',')}` }, 400);
  }
  let limit = 25;
  if (limitQ) {
    const n = Number(limitQ);
    if (!Number.isFinite(n) || n <= 0 || n > 200) {
      return c.json({ error: 'limit must be 1..200' }, 400);
    }
    limit = Math.floor(n);
  }

  const privilege: string | null = privilegeQ ?? null;
  const space: string | null = spaceQ ?? null;

  const rows = await sql`
    SELECT id, plan_id, goal_id, intent_type, target_channel, status, priority,
           privilege, space, scheduled_for, created_at, updated_at,
           human_gate_reason, reclaim_count
    FROM cc_intents
    WHERE status = 'pending'
      AND (${privilege}::text IS NULL OR privilege = ${privilege})
      AND (${space}::text IS NULL OR space = ${space})
      AND (scheduled_for IS NULL OR scheduled_for <= NOW())
    ORDER BY priority ASC, created_at ASC
    LIMIT ${limit}
  `;

  return c.json({
    intents: rows,
    filter: { privilege, space, limit },
    count: rows.length,
  });
});

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// POST /api/triage/:id/claim — claim a specific pending intent by ID.
// Atomic via UPDATE...WHERE status='pending' RETURNING. Returns 409 if the
// intent is no longer pending (already claimed, running, etc).
triageRoutes.post('/:id/claim', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id required' }, 400);

  // Confirm existence vs. status separately so 404 and 409 are distinguishable.
  const existing = await sql`SELECT id, status, scheduled_for FROM cc_intents WHERE id = ${id} LIMIT 1`;
  if (existing.length === 0) return c.json({ error: 'Intent not found' }, 404);

  // Finding 5: list + claim-next exclude future scheduled_for, so the direct
  // claim path must too — otherwise a client with the ID can short-circuit the
  // schedule and pull tomorrow's work today.
  const claimed = await sql`
    UPDATE cc_intents
    SET status = 'claimed', updated_at = NOW()
    WHERE id = ${id}
      AND status = 'pending'
      AND (scheduled_for IS NULL OR scheduled_for <= NOW())
    RETURNING *
  `;

  if (claimed.length === 0) {
    const scheduledFor = existing[0].scheduled_for as string | null;
    if (
      existing[0].status === 'pending' &&
      scheduledFor &&
      new Date(scheduledFor) > new Date()
    ) {
      return c.json(
        {
          error: 'Intent scheduled for future; refusing to claim early',
          scheduled_for: scheduledFor,
        },
        409,
      );
    }
    return c.json(
      { error: 'Intent already claimed or not pending', current_status: existing[0].status },
      409,
    );
  }

  return c.json({ intent: claimed[0] });
});

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// POST /api/triage/claim-next — bucket-ordered claim used by autonomous
// agents. Filters delegated to meta/intent.ts claimNextIntent().
triageRoutes.post('/claim-next', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const privilegeRaw = (body as Record<string, unknown>).privilege;
  const spaceRaw = (body as Record<string, unknown>).space;
  // If a filter is PROVIDED but doesn't parse, reject with 400 — otherwise the
  // null fallthrough would silently claim from any bucket including
  // privileged/legalink, which a caller filtering for e.g. "pii" definitely
  // did not intend (e.g. typo "pi" → null → claim privileged work).
  const privilege = parsePrivilege(privilegeRaw);
  if (privilegeRaw !== undefined && privilegeRaw !== null && privilege === null) {
    return c.json(
      { error: `Invalid privilege; must be one of ${[...VALID_PRIVILEGE].join(',')}` },
      400,
    );
  }
  const space = parseSpace(spaceRaw);
  if (spaceRaw !== undefined && spaceRaw !== null && space === null) {
    return c.json(
      { error: `Invalid space; must be one of ${[...VALID_SPACE].join(',')}` },
      400,
    );
  }
  const priorityLteRaw = (body as Record<string, unknown>).priority_lte;
  let priorityLte: number | undefined;
  if (priorityLteRaw !== undefined && priorityLteRaw !== null) {
    const n = Number(priorityLteRaw);
    if (!Number.isFinite(n)) return c.json({ error: 'priority_lte must be a number' }, 400);
    priorityLte = Math.floor(n);
  }

  const intent = await claimNextIntent(c.env, {
    privilege: privilege ?? undefined,
    space: space ?? undefined,
    priorityLte,
  });

  if (!intent) {
    return c.json({ intent: null, message: 'Queue empty for the requested bucket' }, 404);
  }
  return c.json({ intent });
});

// @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
// POST /api/triage/:id/complete — terminal transition. Respects the
// 'running'-only guard for done; allows claimed-or-running for failed.
triageRoutes.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id required' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const outcome = (body as Record<string, unknown>).outcome;
  if (outcome !== 'done' && outcome !== 'failed') {
    return c.json({ error: "outcome must be 'done' or 'failed'" }, 400);
  }

  if (outcome === 'done') {
    const updated = await completeIntent(c.env, id);
    if (!updated) {
      return c.json(
        { error: "Intent not in 'claimed' or 'running' state; refusing to mark done" },
        409,
      );
    }
    return c.json({ intent: updated });
  }

  const errMsg = String((body as Record<string, unknown>).error ?? 'failed via /complete');
  const updated = await failIntent(c.env, id, errMsg);
  if (!updated) {
    return c.json(
      { error: "Intent not in 'claimed' or 'running' state; refusing to mark failed" },
      409,
    );
  }
  return c.json({ intent: updated });
});
