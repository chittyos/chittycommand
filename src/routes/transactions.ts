import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';

export const transactionRoutes = new Hono<{ Bindings: Env }>();

// List transactions with filtering and pagination
transactionRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const accountId = c.req.query('account_id') || null;
  const source = c.req.query('source') || null;
  const direction = c.req.query('direction') || null;
  const category = c.req.query('category') || null;
  const from = c.req.query('from') || null;
  const to = c.req.query('to') || null;
  const search = c.req.query('search') || null;
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const offset = Number(c.req.query('offset')) || 0;
  const searchPattern = search ? `%${search}%` : null;

  const [countRow] = await sql`
    SELECT COUNT(*) AS total FROM cc_transactions
    WHERE (${accountId}::uuid IS NULL OR account_id = ${accountId}::uuid)
      AND (${source}::text IS NULL OR source = ${source})
      AND (${direction}::text IS NULL OR direction = ${direction})
      AND (${category}::text IS NULL OR category = ${category})
      AND (${from}::date IS NULL OR tx_date >= ${from}::date)
      AND (${to}::date IS NULL OR tx_date <= ${to}::date)
      AND (${searchPattern}::text IS NULL OR counterparty ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
  `;

  const rows = await sql`
    SELECT * FROM cc_transactions
    WHERE (${accountId}::uuid IS NULL OR account_id = ${accountId}::uuid)
      AND (${source}::text IS NULL OR source = ${source})
      AND (${direction}::text IS NULL OR direction = ${direction})
      AND (${category}::text IS NULL OR category = ${category})
      AND (${from}::date IS NULL OR tx_date >= ${from}::date)
      AND (${to}::date IS NULL OR tx_date <= ${to}::date)
      AND (${searchPattern}::text IS NULL OR counterparty ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
    ORDER BY tx_date DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return c.json({
    transactions: rows,
    total: Number(countRow.total),
    limit,
    offset,
  });
});

// Summary: totals by direction and category for a date range
// Must be registered before /:id to avoid matching "summary" as a UUID
transactionRoutes.get('/summary/totals', async (c) => {
  const sql = getDb(c.env);
  const from = c.req.query('from') || null;
  const to = c.req.query('to') || null;
  const accountId = c.req.query('account_id') || null;

  const rows = await sql`
    SELECT direction, category, COUNT(*) AS count, SUM(amount::numeric) AS total
    FROM cc_transactions
    WHERE (${from}::date IS NULL OR tx_date >= ${from}::date)
      AND (${to}::date IS NULL OR tx_date <= ${to}::date)
      AND (${accountId}::uuid IS NULL OR account_id = ${accountId}::uuid)
    GROUP BY direction, category
    ORDER BY direction, total DESC
  `;

  return c.json({ summary: rows });
});

// Get single transaction
transactionRoutes.get('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const [tx] = await sql`SELECT * FROM cc_transactions WHERE id = ${id}`;
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);
  return c.json(tx);
});
