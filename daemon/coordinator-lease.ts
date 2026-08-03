/**
 * Coordinator-backed lease client — drop-in replacement for daemon/leader.ts.
 *
 * Exports the same four functions with the same signatures and return shapes,
 * so daemon/loop.ts switches by changing one import path. The arbiter moves
 * from Neon `cc_node_leases` to the CommandCoordinator Durable Object
 * (meta/coordinator.ts).
 *
 * Why: ADR-001 used Neon leases to elect a leader across chittymini-01..06.
 * A DO is already a strongly-consistent singleton, so election is unnecessary —
 * and the Neon dependency, which is cost-driven pressure, leaves this layer.
 *
 * Fails closed. With no coordinator configured this throws rather than
 * degrading to an unarbitrated local decision, which would permit split-brain.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import { META_LEADER_ROLE, type StoredLease } from '../meta/coordinator';

export { META_LEADER_ROLE };

export const POLICY_BLOCKED_COORDINATOR_UNAVAILABLE =
  'POLICY_BLOCKED_COORDINATOR_UNAVAILABLE';

export interface CoordinatorEnv {
  /** Base URL of the ChittyCommand worker, e.g. https://command.chitty.cc */
  COORDINATOR_URL?: string;
  /** Bearer token for the coordinator routes. Broker-provided; never inlined. */
  COORDINATOR_TOKEN?: string;
}

/** Identical to NodeLease in daemon/leader.ts. */
export interface NodeLease {
  role: string;
  nodeId: string;
  nodeDescriptor: string | null;
  sessionId: string | null;
  claimedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
  metadata: Record<string, unknown>;
}

export interface ClaimOptions {
  nodeId: string;
  nodeDescriptor?: string;
  sessionId?: string;
  leaseSeconds?: number;
  role?: string;
  metadata?: Record<string, unknown>;
}

function baseUrl(env: CoordinatorEnv): string {
  const url = env.COORDINATOR_URL?.replace(/\/+$/, '');
  if (!url) throw new Error(POLICY_BLOCKED_COORDINATOR_UNAVAILABLE);
  return url;
}

async function call<T>(
  env: CoordinatorEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.COORDINATOR_TOKEN) headers.authorization = `Bearer ${env.COORDINATOR_TOKEN}`;

  const res = await fetch(`${baseUrl(env)}/api/meta/coordinator${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    throw new Error(
      `[daemon/coordinator-lease] ${method} ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

/** Rehydrate ISO strings into Dates. Returns null for an unheld lease. */
function toLease(stored: StoredLease | null): NodeLease | null {
  if (!stored?.nodeId || !stored.claimedAt || !stored.heartbeatAt || !stored.leaseExpiresAt) {
    return null;
  }
  return {
    role: stored.role,
    nodeId: stored.nodeId,
    nodeDescriptor: stored.nodeDescriptor,
    sessionId: stored.sessionId,
    claimedAt: new Date(stored.claimedAt),
    heartbeatAt: new Date(stored.heartbeatAt),
    leaseExpiresAt: new Date(stored.leaseExpiresAt),
    metadata: stored.metadata ?? {},
  };
}

export async function claimLeadership(
  env: CoordinatorEnv,
  options: ClaimOptions,
): Promise<NodeLease | null> {
  if (!options?.nodeId) throw new Error('[daemon/coordinator-lease] nodeId is required');
  return toLease(
    await call<StoredLease | null>(env, 'POST', '/claim', {
      nodeId: options.nodeId,
      nodeDescriptor: options.nodeDescriptor ?? null,
      sessionId: options.sessionId ?? null,
      leaseSeconds: options.leaseSeconds,
      role: options.role,
      metadata: options.metadata ?? {},
    }),
  );
}

export async function heartbeat(
  env: CoordinatorEnv,
  nodeId: string,
  options: { role?: string; leaseSeconds?: number; sessionId?: string | null } = {},
): Promise<NodeLease | null> {
  if (!nodeId) throw new Error('[daemon/coordinator-lease] nodeId is required for heartbeat');
  return toLease(
    await call<StoredLease | null>(env, 'POST', '/heartbeat', {
      nodeId,
      role: options.role,
      leaseSeconds: options.leaseSeconds,
      sessionId: options.sessionId ?? null,
    }),
  );
}

export async function releaseLeadership(
  env: CoordinatorEnv,
  nodeId: string,
  options: { role?: string; sessionId?: string | null } = {},
): Promise<boolean> {
  if (!nodeId) throw new Error('[daemon/coordinator-lease] nodeId is required for release');
  const res = await call<{ released: boolean }>(env, 'POST', '/release', {
    nodeId,
    role: options.role,
    sessionId: options.sessionId ?? null,
  });
  return res.released === true;
}

export async function describeLease(
  env: CoordinatorEnv,
  options: { role?: string } = {},
): Promise<NodeLease | null> {
  const role = options.role ?? META_LEADER_ROLE;
  return toLease(
    await call<StoredLease | null>(
      env,
      'GET',
      `/describe?role=${encodeURIComponent(role)}`,
    ),
  );
}
