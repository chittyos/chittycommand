/**
 * Channel registry resolver.
 *
 * Per the global Channel Registration Protocol (CLAUDE.md), every channel/MCP
 * client that talks to the ChittyOS ecosystem registers via
 * `agent.chitty.cc/api/v1/channels/register` and receives back a ChittyID and
 * capability manifest. This module is the chittycommand-side lookup.
 *
 * v1 (this file): env-var allowlist parsed from `REGISTERED_CHANNELS_JSON`
 *                 (a JSON object keyed by channel_id).
 *
 * v2 (planned):   HTTP call to `agent.chitty.cc/api/v1/channels/{channelId}`
 *                 with the same return shape. See TODO below.
 *
 * @canon: chittycanon://core/services/chittycommand/channel-registry
 */

import type { Env } from '../index';

export interface ChannelMeta {
  channel_id: string;
  chitty_id: string;
  platform: string;
  capabilities: string[];
  contact_endpoint?: string;
  status: 'active' | 'suspended' | 'pending';
}

interface ChannelRegistryEnv extends Pick<Env, 'COMMAND_KV'> {
  REGISTERED_CHANNELS_JSON?: string;
}

/**
 * The canonical Workspace Studio channel ChittyID — used when registering the
 * Workspace Add-on as a channel under the universal protocol. Surface this
 * value so it can be added to REGISTERED_CHANNELS_JSON.
 */
export const WORKSPACE_STUDIO_CHANNEL_ID = 'chitty:channel:workspace-studio-gmail';

/**
 * Resolve a channel's metadata, or null if the channel is not registered or
 * not active.
 *
 * TODO(v2): Replace env-var lookup with a fetch to
 *           `agent.chitty.cc/api/v1/channels/{channelId}` and cache the result
 *           in `COMMAND_KV` under `channel:meta:{channel_id}` with a 5-minute
 *           TTL. Same return shape — callers do not need to change.
 */
export async function verifyRegisteredChannel(
  channelId: string,
  env: ChannelRegistryEnv,
  requiredCapabilities: string[] = [],
): Promise<ChannelMeta | null> {
  if (!channelId) return null;

  const raw = env.REGISTERED_CHANNELS_JSON;
  if (!raw) return null;
  let parsed: Record<string, ChannelMeta>;
  try {
    parsed = JSON.parse(raw) as Record<string, ChannelMeta>;
  } catch {
    console.warn('[channel-registry] REGISTERED_CHANNELS_JSON is not valid JSON');
    return null;
  }
  const meta = parsed[channelId];
  if (!meta) return null;
  if (meta.status !== 'active') return null;
  // Capability gate: the channel must declare every required capability. A
  // registered+active channel that lacks the capability for THIS operation
  // (e.g. an SMS channel asked to perform `gmail.ingest`) must be rejected
  // so the capability manifest is actually enforced.
  if (requiredCapabilities.length > 0) {
    const caps = new Set(meta.capabilities ?? []);
    for (const cap of requiredCapabilities) {
      if (!caps.has(cap)) return null;
    }
  }
  return meta;
}
