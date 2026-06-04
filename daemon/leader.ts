/**
 * Cluster daemon — leader election via Neon `cc_node_leases`.
 *
 * Mirrors the lease pattern in
 * chittyentity/workers/shared/agent-tasks.ts (`task_leases`):
 *   - atomic claim via UPDATE ... RETURNING with expired-lease takeover
 *   - heartbeat extends lease_expires_at
 *   - explicit release nullifies the holder
 *
 * Schema: see `cc_node_leases` in src/db/schema.ts.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export interface LeaderEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

/** The canonical foundation-PR role. New roles can be added later. */
export const META_LEADER_ROLE = 'meta-orchestrator-leader' as const;

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
  /** ChittyID of the node attempting to claim (Location type — L). */
  nodeId: string;
  /** Free-form descriptor for ops (e.g. "chittymini-03"). */
  nodeDescriptor?: string;
  /** Process/session id for this attempt. */
  sessionId?: string;
  /** Lease length in seconds. Defaults to 30s. */
  leaseSeconds?: number;
  /** The role to claim. Defaults to META_LEADER_ROLE. */
  role?: string;
  /** Optional metadata persisted with the lease. */
  metadata?: Record<string, unknown>;
}

function getSql(env: LeaderEnv): NeonQueryFunction<false, false> {
  const conn = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  if (!conn) {
    throw new Error('[daemon/leader] No DATABASE_URL or HYPERDRIVE connection string');
  }
  return neon(conn);
}

function normalizeLeaseSeconds(input: number | undefined): number {
  if (!input || !Number.isFinite(input) || input <= 0) return 30;
  // Clamp to 1s .. 1h to avoid pathological leases.
  return Math.max(1, Math.min(3600, Math.floor(input)));
}

/**
 * Atomically claim leadership for `role`.
 *
 * Logic:
 *   - Insert the role row if missing (idempotent via ON CONFLICT DO NOTHING).
 *   - UPDATE the row to set node_id/sessionId IFF the current holder is the
 *     same node (re-claim) OR the lease is unset/expired.
 *   - Returns the new lease if the UPDATE affected a row, else null.
 *
 * No other Neon round-trip happens between the conditional SELECT and the
 * UPDATE — the WHERE clause inside UPDATE is itself the gate, so concurrent
 * claimers from different nodes will see exactly one winner.
 */
export async function claimLeadership(
  env: LeaderEnv,
  options: ClaimOptions,
): Promise<NodeLease | null> {
  if (!options.nodeId) throw new Error('[daemon/leader] nodeId is required');

  const sql = getSql(env);
  const role = options.role ?? META_LEADER_ROLE;
  const leaseSeconds = normalizeLeaseSeconds(options.leaseSeconds);
  const sessionId = options.sessionId ?? null;
  const descriptor = options.nodeDescriptor ?? null;
  const metadata = JSON.stringify(options.metadata ?? {});

  // 1. Ensure a row exists for this role. Idempotent.
  await sql`
    INSERT INTO cc_node_leases (role, metadata)
    VALUES (${role}, ${metadata}::jsonb)
    ON CONFLICT (role) DO NOTHING`;

  // 2. Atomic claim.
  const rows = await sql`
    UPDATE cc_node_leases
    SET node_id = ${options.nodeId},
        node_descriptor = ${descriptor},
        session_id = ${sessionId},
        claimed_at = COALESCE(claimed_at, NOW()),
        heartbeat_at = NOW(),
        lease_expires_at = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        metadata = ${metadata}::jsonb,
        updated_at = NOW()
    WHERE role = ${role}
      AND (
        node_id IS NULL
        OR node_id = ${options.nodeId}
        OR lease_expires_at IS NULL
        OR lease_expires_at < NOW()
      )
    RETURNING *`;

  if (rows.length === 0) return null;
  return rowToLease(rows[0]);
}

/**
 * Extend the lease. Returns null if this node is no longer the holder
 * (another node took over) OR if the caller's sessionId does not match the
 * session currently recorded on the lease — a restarted process with the same
 * nodeId cannot heartbeat over a fresh leader.
 *
 * fixes codex-p2 PR#101 finding-5 — session ownership required on heartbeat.
 */
export async function heartbeat(
  env: LeaderEnv,
  nodeId: string,
  options: { role?: string; leaseSeconds?: number; sessionId?: string | null } = {},
): Promise<NodeLease | null> {
  if (!nodeId) throw new Error('[daemon/leader] nodeId is required for heartbeat');
  const sql = getSql(env);
  const role = options.role ?? META_LEADER_ROLE;
  const leaseSeconds = normalizeLeaseSeconds(options.leaseSeconds);
  const sessionId = options.sessionId ?? null;

  const rows = await sql`
    UPDATE cc_node_leases
    SET heartbeat_at = NOW(),
        lease_expires_at = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        updated_at = NOW()
    WHERE role = ${role}
      AND node_id = ${nodeId}
      AND session_id IS NOT DISTINCT FROM ${sessionId}
    RETURNING *`;
  return rows[0] ? rowToLease(rows[0]) : null;
}

/**
 * Release leadership. Only this node + session can release — if a different
 * node or a newer session of the same node holds the role, this is a no-op.
 *
 * fixes codex-p2 PR#101 finding-2 — session ownership required on release.
 */
export async function releaseLeadership(
  env: LeaderEnv,
  nodeId: string,
  options: { role?: string; sessionId?: string | null } = {},
): Promise<boolean> {
  if (!nodeId) throw new Error('[daemon/leader] nodeId is required for release');
  const sql = getSql(env);
  const role = options.role ?? META_LEADER_ROLE;
  const sessionId = options.sessionId ?? null;
  const rows = await sql`
    UPDATE cc_node_leases
    SET node_id = NULL,
        session_id = NULL,
        node_descriptor = NULL,
        claimed_at = NULL,
        heartbeat_at = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE role = ${role}
      AND node_id = ${nodeId}
      AND session_id IS NOT DISTINCT FROM ${sessionId}
    RETURNING role`;
  return rows.length > 0;
}

/**
 * Inspect the current lease row (no mutation). Useful for diagnostics.
 */
export async function describeLease(
  env: LeaderEnv,
  options: { role?: string } = {},
): Promise<NodeLease | null> {
  const sql = getSql(env);
  const role = options.role ?? META_LEADER_ROLE;
  const rows = await sql`SELECT * FROM cc_node_leases WHERE role = ${role} LIMIT 1`;
  if (!rows[0] || !rows[0].node_id) return null;
  return rowToLease(rows[0]);
}

function rowToLease(row: Record<string, unknown>): NodeLease {
  return {
    role: String(row.role),
    nodeId: String(row.node_id),
    nodeDescriptor: (row.node_descriptor as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    claimedAt: new Date(row.claimed_at as string),
    heartbeatAt: new Date(row.heartbeat_at as string),
    leaseExpiresAt: new Date(row.lease_expires_at as string),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}
