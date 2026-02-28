import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { getDb } from '../../lib/db';
import { booksClient } from '../../lib/integrations';
import { recordBookTransactionSchema } from '../../lib/validators';

export const booksRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── ChittyBooks ─────────────────────────────────────────────

/** Record a transaction in ChittyBooks for bookkeeping */
booksRoutes.post('/record-transaction', async (c) => {
  const books = booksClient(c.env);
  if (!books) return c.json({ error: 'ChittyBooks not configured' }, 503);

  const parsed = recordBookTransactionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const body = parsed.data;

  const result = await books.recordTransaction(body);
  if (!result) return c.json({ error: 'Failed to record transaction in ChittyBooks' }, 502);

  const sql = getDb(c.env);
  await sql`
    INSERT INTO cc_actions_log (action_type, target_type, description, request_payload, response_payload, status)
    VALUES ('books_record', 'transaction', ${body.description}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb, 'completed')
  `;

  return c.json({ recorded: true, books_result: result });
});

/** Get ChittyBooks financial summary */
booksRoutes.get('/summary', async (c) => {
  const books = booksClient(c.env);
  if (!books) return c.json({ error: 'ChittyBooks not configured' }, 503);

  const summary = await books.getSummary();
  if (!summary) return c.json({ error: 'Failed to fetch summary from ChittyBooks' }, 502);

  return c.json(summary);
});
