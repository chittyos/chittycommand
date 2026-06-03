/**
 * Meta-orchestrator — Channel fanout interface.
 *
 * Reads the registered-channel list from the ChittyAgent channel registry
 * (agent.chitty.cc/api/v1/channels). Per ADR-001 and the binding rule on
 * no-mocks/no-stubs, if the registry is unreachable this function throws —
 * it does not return a synthesized list.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

export interface ChannelsEnv {
  /** Override the default https://agent.chitty.cc base URL. */
  CHITTYAGENT_URL?: string;
  /** Optional service token for the channels API. */
  CHITTYAGENT_TOKEN?: string;
}

export type ChannelType =
  | 'cloud-mcp'
  | 'local-ide'
  | 'desktop'
  | 'mobile'
  | 'remote'
  | 'homelab'
  | 'dev-server'
  | 'model-api'
  | 'other';

export interface Channel {
  /** Channel identifier (often a ChittyID for the channel's host). */
  id: string;
  /** Human-readable name. */
  name: string;
  type: ChannelType | string;
  /** Capability tags advertised by the channel. */
  capabilities?: string[];
  /** Endpoint the channel can be reached on (HTTP, MCP, etc.). */
  endpoint?: string;
  status?: 'online' | 'offline' | 'degraded' | string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_AGENT_URL = 'https://agent.chitty.cc';

/**
 * List currently registered channels. Throws on any non-2xx or transport error
 * — callers MUST handle the throw and decide whether to retry, park, or
 * surface the error.
 */
export async function listRegisteredChannels(env: ChannelsEnv): Promise<Channel[]> {
  const base = (env.CHITTYAGENT_URL ?? DEFAULT_AGENT_URL).replace(/\/$/, '');
  const url = `${base}/api/v1/channels`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-ChittyOS-Caller': 'chittycommand-meta-orchestrator',
  };
  if (env.CHITTYAGENT_TOKEN) {
    headers.Authorization = `Bearer ${env.CHITTYAGENT_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new Error(
      `[meta/channels] ChittyAgent channels endpoint unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[meta/channels] ChittyAgent channels endpoint returned HTTP ${res.status} ${res.statusText} at ${url}: ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as unknown;
  return normalizeChannels(data);
}

function normalizeChannels(data: unknown): Channel[] {
  if (Array.isArray(data)) {
    return data.map(toChannel);
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.channels)) return (obj.channels as unknown[]).map(toChannel);
    if (Array.isArray(obj.data)) return (obj.data as unknown[]).map(toChannel);
  }
  throw new Error(
    `[meta/channels] Unexpected channels payload shape; expected array or {channels:[]}, got: ${JSON.stringify(data).slice(0, 200)}`,
  );
}

function toChannel(raw: unknown): Channel {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? r.chittyId ?? r.channel_id ?? ''),
    name: String(r.name ?? r.displayName ?? r.id ?? ''),
    type: (r.type ?? r.channel_type ?? 'other') as ChannelType,
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : undefined,
    endpoint:
      typeof r.endpoint === 'string'
        ? r.endpoint
        : typeof r.url === 'string'
          ? (r.url as string)
          : undefined,
    status: typeof r.status === 'string' ? r.status : undefined,
    metadata: (r.metadata as Record<string, unknown>) ?? undefined,
  };
}
