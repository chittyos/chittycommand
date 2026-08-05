/**
 * Runtime-free lease vocabulary shared by the Durable Object arbiter
 * (meta/coordinator.ts, workerd) and the daemon client
 * (daemon/coordinator-lease.ts, Node on cluster hardware).
 *
 * This module must NOT import `cloudflare:workers` or anything else that only
 * resolves inside workerd. The daemon evaluates it on plain Node, where such an
 * import fails at module load — before main(), before any log line.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

/** Canonical role claimed by the meta-orchestrator loop. */
export const META_LEADER_ROLE = 'meta-orchestrator-leader' as const;

/** Lease bounds, mirroring normalizeLeaseSeconds() in daemon/leader.ts. */
export const MIN_LEASE_SECONDS = 1;
export const MAX_LEASE_SECONDS = 3600;
export const DEFAULT_LEASE_SECONDS = 30;

/** Stored form. Dates are ISO strings; the client rehydrates them. */
export interface StoredLease {
  role: string;
  nodeId: string | null;
  nodeDescriptor: string | null;
  sessionId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ClaimBody {
  nodeId: string;
  nodeDescriptor?: string | null;
  sessionId?: string | null;
  leaseSeconds?: number;
  role?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeLeaseSeconds(input: number | undefined): number {
  if (!input || !Number.isFinite(input) || input <= 0) return DEFAULT_LEASE_SECONDS;
  return Math.max(MIN_LEASE_SECONDS, Math.min(MAX_LEASE_SECONDS, Math.floor(input)));
}
