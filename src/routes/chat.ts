import { Hono } from 'hono';
import type { z } from 'zod';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';
import { getDb } from '../lib/db';
import { chatRequestSchema } from '../lib/validators';

export const chatRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

type ChatRequest = z.infer<typeof chatRequestSchema>;

async function buildSystemPrompt(
  env: Env,
  context?: ChatRequest['context'],
): Promise<string> {
  const sql = getDb(env);

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
    if (context?.page === '/queue' && context.item_id) {
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
    } else if (context?.page === '/bills' && context.item_id) {
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
    contextBlock = '\n\n[Note: Unable to load details for the item you are viewing. Responses may lack specific context.]';
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
  const raw = await c.req.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }
  const body = parsed.data;

  // Fetch model override and system prompt in parallel (independent I/O)
  const [chatModel, systemPrompt] = await Promise.all([
    c.env.COMMAND_KV.get('chat:model').catch((err) => {
      console.error('[chat] KV read failed, using default model:', err instanceof Error ? err.message : err);
      return null;
    }),
    buildSystemPrompt(c.env, body.context).catch((err) => {
      console.error('[chat] failed to build system prompt:', err instanceof Error ? err.message : err);
      return null;
    }),
  ]);

  if (systemPrompt === null) {
    return c.json({ error: 'Unable to load financial context. Please try again.' }, 503);
  }

  let gatewayUrl: string;
  try {
    const gateway = c.env.AI.gateway('chittygateway');
    gatewayUrl = await gateway.getUrl();
  } catch (err) {
    console.error('[chat] AI gateway binding error:', err instanceof Error ? err.message : err);
    return c.json({ error: 'AI service is not configured.' }, 503);
  }

  const model = chatModel || 'dynamic/chittycommand';

  let response: Response;
  try {
    response = await fetch(new URL('compat/chat/completions', gatewayUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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
      return c.json({ error: 'AI gateway timed out. Please try again.' }, 504);
    }
    console.error('[chat] gateway error:', err instanceof Error ? err.message : err);
    return c.json({ error: 'AI gateway error' }, 502);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '(unable to read error body)');
    console.error('[chat] gateway error:', response.status, errText);
    if (response.status === 429) {
      return c.json({ error: 'AI service is rate limited. Please wait a moment.' }, 429);
    }
    return c.json({ error: `AI gateway error (${response.status})` }, 502);
  }

  if (!response.body) {
    return c.json({ error: 'AI gateway returned no data' }, 502);
  }

  return c.newResponse(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
});
