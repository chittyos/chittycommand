import { Hono } from 'hono';
import type { z } from 'zod';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import { chatRequestSchema } from '../lib/validators';

export const chatRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

type ChatRequest = z.infer<typeof chatRequestSchema>;

// Build system prompt with financial context from DB
async function buildSystemPrompt(
  env: Env,
  context?: ChatRequest['context'],
): Promise<string> {
  const sql = getDb(env);

  // Fetch cash position snapshot (parallelized)
  const [[cash], [overdue], [dueSoon]] = await Promise.all([
    sql`SELECT COALESCE(SUM(current_balance), 0) as total
        FROM cc_accounts WHERE account_type IN ('checking', 'savings')`,
    sql`SELECT COUNT(*) as count,
           COALESCE(SUM(COALESCE(amount_due::numeric, 0)), 0) as total
        FROM cc_obligations WHERE status = 'overdue'`,
    sql`SELECT COUNT(*) as count
        FROM cc_obligations
        WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'`,
  ]);

  let contextBlock = '';

  // Add page-specific context (failure here should not block the chat)
  try {
    if (context?.page === '/queue' && context?.item_id) {
      const [item] = await sql`
        SELECT r.*, o.payee, o.amount_due, o.due_date, o.category, o.status as ob_status
        FROM cc_recommendations r
        LEFT JOIN cc_obligations o ON r.obligation_id = o.id
        WHERE r.id = ${context.item_id}::uuid
      `;
      if (item) {
        contextBlock = `\n\nCurrently viewing action queue item: "${item.title}"
Payee: ${item.payee || 'N/A'}, Amount: $${item.amount_due || '?'}, Due: ${item.due_date || '?'}
Category: ${item.category || '?'}, Status: ${item.ob_status || '?'}
AI reasoning: ${item.reasoning || 'N/A'}`;
      }
    } else if (context?.page === '/bills' && context?.item_id) {
      const [ob] = await sql`
        SELECT * FROM cc_obligations WHERE id = ${context.item_id}::uuid
      `;
      if (ob) {
        contextBlock = `\n\nCurrently viewing obligation: ${ob.payee}
Amount: $${ob.amount_due}, Due: ${ob.due_date}, Status: ${ob.status}
Category: ${ob.category}, Auto-pay: ${ob.auto_pay}`;
      }
    }
  } catch (err) {
    console.error('[chat] failed to fetch page context:', err instanceof Error ? err.message : err);
  }

  return `You are the ChittyCommand Assistant — an AI financial advisor embedded in a life management dashboard.

Current financial snapshot:
- Cash position: $${Number(cash.total).toLocaleString()}
- Overdue bills: ${overdue.count} totaling $${Number(overdue.total).toLocaleString()}
- Due this week: ${dueSoon.count}
${contextBlock}

You help the user understand their financial position, explain recommendations, explore what-if scenarios, and take actions on their behalf when asked. Be concise and direct. Use dollar amounts and dates. When you don't know something, say so.`;
}

chatRoutes.post('/', async (c) => {
  const [gatewayToken, gatewayUrl, chatModel] = await Promise.all([
    c.env.COMMAND_KV.get('chat:cf_aig_token'),
    c.env.COMMAND_KV.get('chat:cf_aig_url'),
    c.env.COMMAND_KV.get('chat:model'),
  ]);
  if (!gatewayToken || !gatewayUrl) {
    return c.json({ error: 'Chat not configured — missing gateway credentials' }, 503);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON in request body' }, 400);
  }

  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }
  const body = parsed.data;

  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(c.env, body.context);
  } catch (err) {
    console.error('[chat] failed to build system prompt:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Unable to load financial context. Please try again.' }, 503);
  }

  let response: Response;
  try {
    response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${gatewayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: chatModel || 'anthropic/claude-sonnet-4-5',
        messages: [
          { role: 'system', content: systemPrompt },
          ...body.messages.slice(-20),
        ],
        stream: true,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.error('[chat] gateway timeout after 30s');
      return c.json({ error: 'AI gateway timed out. Please try again.' }, 504);
    }
    throw err;
  }

  if (!response.ok) {
    const err = await response.text().catch(() => 'Gateway error');
    console.error('[chat] gateway error:', response.status, err);
    return c.json({ error: 'AI gateway error' }, 502);
  }

  if (!response.body) {
    console.error('[chat] gateway returned empty body');
    return c.json({ error: 'AI gateway returned no data' }, 502);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
    const body = await response.text().catch(() => '(unreadable)');
    console.error('[chat] gateway unexpected content-type:', contentType, body.slice(0, 500));
    return c.json({ error: 'AI gateway returned an unexpected response' }, 502);
  }

  // Stream SSE back to client
  return c.newResponse(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
