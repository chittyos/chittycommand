import { Hono } from 'hono';
import type { Env } from '../index';
import { z } from 'zod';
import { contextUpdateSchema } from '../lib/validators';

export const contextRoutes = new Hono<{ Bindings: Env }>();

type StoredContext = {
  label?: string | null;
  persona?: string | null;
  tags?: string[];
  updated_at: string;
};

function ensureScopes(scopes: unknown, required: string[]): boolean {
  if (!Array.isArray(scopes)) return false;
  return required.some((r) => (scopes as string[]).includes(r));
}

// Get current user's context
contextRoutes.get('/context', async (c) => {
  // @ts-expect-error app-level variables
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  const key = `context:user:${userId}`;
  const raw = await c.env.COMMAND_KV.get(key);
  const payload: StoredContext | null = raw ? JSON.parse(raw) : null;
  return c.json({ userId, ...(payload || { label: null, persona: null, tags: [], updated_at: null }) });
});

// Update current user's context (admin or mcp permitted)
contextRoutes.post('/context', async (c) => {
  // @ts-expect-error app-level variables
  const userId = c.get('userId') as string | undefined;
  // @ts-expect-error app-level variables
  const scopes = (c.get('scopes') as string[] | undefined) || [];
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  if (!ensureScopes(scopes, ['admin', 'mcp'])) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = contextUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400);
  }
  const now = new Date().toISOString();
  const key = `context:user:${userId}`;
  const currentRaw = await c.env.COMMAND_KV.get(key);
  const current: StoredContext = currentRaw ? JSON.parse(currentRaw) : { updated_at: now };
  const next: StoredContext = {
    label: parsed.data.label ?? current.label ?? null,
    persona: parsed.data.persona ?? current.persona ?? null,
    tags: parsed.data.tags ?? current.tags ?? [],
    updated_at: now,
  };
  await c.env.COMMAND_KV.put(key, JSON.stringify(next));
  return c.json({ userId, ...next });
});

// Global context (admin only) for shared clients like MCP
contextRoutes.get('/context/global', async (c) => {
  const raw = await c.env.COMMAND_KV.get('context:global');
  const payload: StoredContext | null = raw ? JSON.parse(raw) : null;
  return c.json({ scope: 'global', ...(payload || { label: null, persona: null, tags: [], updated_at: null }) });
});

contextRoutes.post('/context/global', async (c) => {
  // @ts-expect-error app-level variables
  const scopes = (c.get('scopes') as string[] | undefined) || [];
  if (!ensureScopes(scopes, ['admin'])) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const parsed = contextUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400);
  }
  const now = new Date().toISOString();
  const currentRaw = await c.env.COMMAND_KV.get('context:global');
  const current: StoredContext = currentRaw ? JSON.parse(currentRaw) : { updated_at: now };
  const next: StoredContext = {
    label: parsed.data.label ?? current.label ?? null,
    persona: parsed.data.persona ?? current.persona ?? null,
    tags: parsed.data.tags ?? current.tags ?? [],
    updated_at: now,
  };
  await c.env.COMMAND_KV.put('context:global', JSON.stringify(next));
  return c.json({ scope: 'global', ...next });
});
