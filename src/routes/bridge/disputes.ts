/**
 * bridge/disputes.ts
 *
 * Manual bidirectional sync trigger for disputes ↔ Notion.
 * Mounted at /api/bridge/disputes via bridgeAuthMiddleware.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { pushUnlinkedDisputesToNotion, reconcileNotionDisputes } from '../../lib/dispute-sync';

export const disputesBridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const syncDirectionSchema = z.object({
  direction: z.enum(['to_notion', 'from_notion', 'both']).optional().default('both'),
});

/**
 * POST /api/bridge/disputes/sync-notion
 *
 * to_notion   — push cc_disputes with no notion_task_id to Notion
 * from_notion — scan cc_tasks(legal) and auto-create cc_disputes
 * both        — run both in sequence (default)
 */
disputesBridgeRoutes.post('/sync-notion', async (c) => {
  const parsed = syncDirectionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { direction } = parsed.data;
  const sql = getDb(c.env);
  const start = Date.now();

  let pushed = 0;
  let reconciled = 0;

  if (direction === 'to_notion' || direction === 'both') {
    try {
      pushed = await pushUnlinkedDisputesToNotion(c.env, sql);
    } catch (err) {
      console.error('[bridge:disputes:sync-notion] push failed:', err);
    }
  }

  if (direction === 'from_notion' || direction === 'both') {
    try {
      reconciled = await reconcileNotionDisputes(c.env, sql);
    } catch (err) {
      console.error('[bridge:disputes:sync-notion] reconcile failed:', err);
    }
  }

  return c.json({ pushed, reconciled, direction, duration_ms: Date.now() - start });
});
