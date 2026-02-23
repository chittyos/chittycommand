import { Hono } from 'hono';
import type { Env } from '../index';
import { getDb } from '../lib/db';
import { createAccountSchema, updateAccountSchema } from '../lib/validators';

export const accountRoutes = new Hono<{ Bindings: Env }>();

// List all accounts
accountRoutes.get('/', async (c) => {
  const sql = getDb(c.env);
  const accounts = await sql`SELECT * FROM cc_accounts ORDER BY institution ASC`;
  return c.json(accounts);
});

// Get single account with recent transactions
accountRoutes.get('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const [account] = await sql`SELECT * FROM cc_accounts WHERE id = ${id}`;
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const transactions = await sql`
    SELECT * FROM cc_transactions WHERE account_id = ${id}
    ORDER BY tx_date DESC LIMIT 50
  `;
  return c.json({ ...account, transactions });
});

// Create account
accountRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const result = createAccountSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;

  const sql = getDb(c.env);
  const [account] = await sql`
    INSERT INTO cc_accounts (source, source_id, account_name, account_type, institution, current_balance, credit_limit, interest_rate, metadata)
    VALUES (${body.source}, ${body.source_id || null}, ${body.account_name}, ${body.account_type}, ${body.institution},
            ${body.current_balance || null}, ${body.credit_limit || null}, ${body.interest_rate || null}, ${JSON.stringify(body.metadata || {})})
    RETURNING *
  `;
  return c.json(account, 201);
});

// Update account
accountRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = updateAccountSchema.safeParse(raw);
  if (!result.success) return c.json({ error: 'Validation failed', issues: result.error.issues }, 400);
  const body = result.data;

  const sql = getDb(c.env);
  const [account] = await sql`
    UPDATE cc_accounts SET
      current_balance = COALESCE(${body.current_balance ?? null}, current_balance),
      credit_limit = COALESCE(${body.credit_limit ?? null}, credit_limit),
      interest_rate = COALESCE(${body.interest_rate ?? null}, interest_rate),
      metadata = COALESCE(${body.metadata ? JSON.stringify(body.metadata) : null}::jsonb, metadata),
      last_synced_at = COALESCE(${body.last_synced_at ?? null}, last_synced_at),
      updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!account) return c.json({ error: 'Account not found' }, 404);
  return c.json(account);
});
