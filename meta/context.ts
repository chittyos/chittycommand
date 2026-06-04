/**
 * Meta-orchestrator — Forever context wrapper.
 *
 * Thin client over ChittyConnect's ContextConsciousness + MemoryCloude APIs,
 * following the primary + fallback pattern of
 * chittyentity/workers/shared/chittyconnect-client.ts.
 *
 * Primary: HTTPS to connect.chitty.cc (when CHITTYCONNECT_URL+TOKEN present).
 * Fallback: service binding (AGENT_CONNECT) for in-cluster routing.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

export interface ContextEnv {
  CHITTYCONNECT_URL?: string;
  /**
   * Canonical ChittyConnect bearer token binding used elsewhere in this
   * worker (see src/lib/cron.ts, src/routes/bridge/*). Preferred name.
   * fixes codex-p2 PR#101 finding-8
   */
  CHITTY_CONNECT_TOKEN?: string;
  /** Legacy name kept for backwards compatibility with earlier ContextEnv shape. */
  CHITTYCONNECT_TOKEN?: string;
  /** Optional service binding for ChittyConnect, used when primary fails. */
  AGENT_CONNECT?: Fetcher;
  /** Caller identity; defaults to "chittycommand-meta". */
  SERVICE_NAME?: string;
}

/**
 * Resolve the ChittyConnect bearer token, preferring the canonical
 * CHITTY_CONNECT_TOKEN binding used by the rest of the worker
 * (src/middleware/auth.ts, src/lib/cron.ts, src/routes/bridge/*) and
 * falling back to the legacy CHITTYCONNECT_TOKEN name.
 *
 * fixes codex-p2 PR#101 finding-8
 */
function resolveConnectToken(env: ContextEnv): string | undefined {
  return env.CHITTY_CONNECT_TOKEN ?? env.CHITTYCONNECT_TOKEN;
}

export type ContextPath = 'primary' | 'fallback';

export interface ContextResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  path: ContextPath;
}

export interface MemoryInteraction {
  summary?: string;
  entities?: string[];
  decisions?: string[];
  actions?: string[];
  metadata?: Record<string, unknown>;
}

export interface EcosystemAwareness {
  success: boolean;
  timestamp?: number;
  ecosystem?: {
    totalServices?: number;
    healthy?: number;
    degraded?: number;
    down?: number;
  };
  services?: { healthy?: string[]; degraded?: string[]; down?: string[] };
  error?: string;
}

const CALLER_DEFAULT = 'chittycommand-meta';

async function request<T>(
  env: ContextEnv,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 8000,
): Promise<{ ok: boolean; data?: T; error?: string; status?: number }> {
  const token = resolveConnectToken(env);
  if (!env.CHITTYCONNECT_URL || !token) {
    return { ok: false, error: 'CHITTYCONNECT_URL or CHITTY_CONNECT_TOKEN not set' };
  }
  const url = `${env.CHITTYCONNECT_URL.replace(/\/$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-ChittyOS-Caller': env.SERVICE_NAME ?? CALLER_DEFAULT,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, status: res.status };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return {
      ok: false,
      error: `ChittyConnect unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function fallback<T>(
  env: ContextEnv,
  method: string,
  internalPath: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!env.AGENT_CONNECT) {
    return { ok: false, error: 'No AGENT_CONNECT service binding' };
  }
  try {
    const res = await env.AGENT_CONNECT.fetch(
      new Request(`https://internal${internalPath}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Fallback HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return {
      ok: false,
      error: `AGENT_CONNECT fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── ContextConsciousness ────────────────────────────────────

export async function getEcosystemAwareness(env: ContextEnv): Promise<EcosystemAwareness> {
  const primary = await request<EcosystemAwareness>(
    env,
    'GET',
    '/api/intelligence/consciousness/awareness',
    undefined,
    5000,
  );
  if (primary.ok && primary.data) return primary.data;

  // fixes codex-p2 PR#101 finding-7 — when the HTTPS path has no URL/token or
  // the upstream fetch failed, route the same request through the AGENT_CONNECT
  // service binding if the worker has one. Matches the persist/recall pattern.
  const fb = await fallback<EcosystemAwareness>(
    env,
    'GET',
    '/api/intelligence/consciousness/awareness',
  );
  if (fb.ok && fb.data) return fb.data;

  return {
    success: false,
    error: primary.error ?? fb.error ?? 'Awareness check failed',
  };
}

// ── MemoryCloude: Persist ───────────────────────────────────

export async function persistMemory(
  env: ContextEnv,
  sessionId: string,
  interaction: MemoryInteraction,
): Promise<ContextResult> {
  const payload = { sessionId, interaction };
  const primary = await request(env, 'POST', '/api/intelligence/memory/persist', payload);
  if (primary.ok) return { ok: true, data: primary.data, path: 'primary' };

  const fb = await fallback(env, 'POST', '/api/v1/memory/persist', payload);
  if (fb.ok) return { ok: true, data: fb.data, path: 'fallback' };

  return { ok: false, error: primary.error ?? fb.error, path: 'primary' };
}

// ── MemoryCloude: Recall ────────────────────────────────────

export interface RecallOptions {
  limit?: number;
  semantic?: boolean;
}

export async function recallMemory(
  env: ContextEnv,
  sessionId: string,
  query: string,
  options?: RecallOptions,
): Promise<ContextResult<{ contexts: unknown[] }>> {
  const payload = { sessionId, query, ...options };
  const primary = await request<{ contexts: unknown[] }>(
    env,
    'POST',
    '/api/intelligence/memory/recall',
    payload,
  );
  if (primary.ok && primary.data) {
    return { ok: true, data: primary.data, path: 'primary' };
  }

  const fb = await fallback<{ contexts: unknown[] }>(env, 'POST', '/api/v1/memory/recall', payload);
  if (fb.ok && fb.data) {
    return { ok: true, data: fb.data, path: 'fallback' };
  }

  return { ok: false, error: primary.error ?? fb.error, path: 'primary' };
}
