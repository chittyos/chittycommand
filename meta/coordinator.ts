/**
 * CommandCoordinator — Durable Object arbiter for meta-orchestrator role leases.
 *
 * Replaces the Neon `cc_node_leases` table (daemon/leader.ts) as the *arbiter*
 * of who holds a role. A Durable Object is already a strongly-consistent,
 * single-threaded singleton, so the properties the Neon lease bought us come
 * free:
 *
 *   - mutual exclusion: the DO serializes requests; no two claimers race
 *   - durability: DO storage survives eviction and restart
 *   - availability: runs on the Cloudflare edge, not on operator hardware
 *
 * ADR-001 elected a leader across `chittymini-01..06` via Neon leases so the
 * coordinator would never be down. That mechanism is unnecessary here — there
 * is no fleet to elect across, because the DO *is* the leader. Nodes remain
 * meaningful as executors that pull work (they have local filesystem and repo
 * access, which is the real reason to run on hardware); they are no longer
 * candidates for leadership.
 *
 * Wire semantics are a deliberate 1:1 port of the SQL in daemon/leader.ts,
 * including two behaviours established by prior review:
 *   - heartbeat requires (role, nodeId, sessionId) to match the holder
 *     (codex-p2 PR#101 finding-5)
 *   - release requires the same triple (codex-p2 PR#101 finding-2)
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 * @canon chittycanon://gov/governance#core-types — a node is a Location (L);
 *        a lease claim is an Event (E).
 */

import { DurableObject } from 'cloudflare:workers';

import {
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  META_LEADER_ROLE,
  MIN_LEASE_SECONDS,
  normalizeLeaseSeconds,
  type ClaimBody,
  type StoredLease,
} from './lease-types';

// Re-exported so existing importers of this module keep working. The
// definitions live in lease-types.ts because the daemon runs on Node and
// cannot evaluate `cloudflare:workers`.
export {
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  META_LEADER_ROLE,
  MIN_LEASE_SECONDS,
  normalizeLeaseSeconds,
};
export type { ClaimBody, StoredLease };

/** Storage key for a role's lease. */
const keyFor = (role: string) => `lease:${role}`;

export class CommandCoordinator extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Anchor on the FIRST '/coordinator' segment. A greedy match here let
    // `/api/meta/coordinator/a/coordinator/release` dispatch `release`.
    const marker = '/coordinator';
    const at = url.pathname.indexOf(marker);
    const path = at === -1 ? '/' : url.pathname.slice(at + marker.length) || '/';

    try {
      switch (`${request.method} ${path}`) {
        case 'POST /claim':
          return json(await this.claim(await readJson<ClaimBody>(request)));
        case 'POST /heartbeat':
          return json(await this.heartbeat(await readJson(request)));
        case 'POST /release':
          return json({ released: await this.release(await readJson(request)) });
        case 'GET /describe':
          return json(await this.describe(url.searchParams.get('role') ?? META_LEADER_ROLE));
        default:
          return json({ error: 'not_found', path }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: 'coordinator_error', message }, 400);
    }
  }

  private async read(role: string): Promise<StoredLease | undefined> {
    return this.ctx.storage.get<StoredLease>(keyFor(role));
  }

  /**
   * Claim `role`. Succeeds when the role is unheld, already held by this same
   * node, or the incumbent's lease has expired.
   *
   * Parity note: `claimedAt` is preserved across takeover, mirroring
   * `COALESCE(claimed_at, NOW())` in the SQL. That means a takeover from an
   * expired holder reports the *previous* holder's claim time. This is
   * deliberate and is not a defect: `claimedAt` reads as "when this role was
   * first continuously held", which is a coherent semantic.
   *
   * It is also load-bearing, not diagnostic — daemon/coordinator-lease.ts
   * returns null when `claimedAt` is falsy, so it participates in the
   * lease/no-lease decision. Any future change has a second consumer.
   */
  async claim(body: ClaimBody): Promise<StoredLease | null> {
    if (!body?.nodeId) throw new Error('[meta/coordinator] nodeId is required');

    const role = body.role ?? META_LEADER_ROLE;
    const leaseSeconds = normalizeLeaseSeconds(body.leaseSeconds);
    const now = Date.now();
    const current = await this.read(role);

    // A corrupted timestamp parses to NaN, and every NaN comparison is false —
    // which would leave the role permanently unclaimable. Postgres typed this
    // column so the SQL had no such failure mode; treat unparseable as expired.
    const expiresAt = current?.leaseExpiresAt ? Date.parse(current.leaseExpiresAt) : NaN;
    const expired = !Number.isFinite(expiresAt) || expiresAt < now;
    const claimable = !current?.nodeId || current.nodeId === body.nodeId || expired;
    if (!claimable) return null;

    const nowIso = new Date(now).toISOString();
    const lease: StoredLease = {
      role,
      nodeId: body.nodeId,
      nodeDescriptor: body.nodeDescriptor ?? null,
      sessionId: body.sessionId ?? null,
      claimedAt: current?.claimedAt ?? nowIso,
      heartbeatAt: nowIso,
      leaseExpiresAt: new Date(now + leaseSeconds * 1000).toISOString(),
      metadata: body.metadata ?? {},
    };

    await this.ctx.storage.put(keyFor(role), lease);
    return lease;
  }

  /**
   * Extend the lease. Returns null when this node is no longer the holder, or
   * when `sessionId` does not match the session recorded on the lease — a
   * restarted process reusing a nodeId cannot heartbeat over a fresh leader.
   */
  async heartbeat(body: {
    nodeId: string;
    role?: string;
    leaseSeconds?: number;
    sessionId?: string | null;
  }): Promise<StoredLease | null> {
    if (!body?.nodeId) throw new Error('[meta/coordinator] nodeId is required for heartbeat');

    const role = body.role ?? META_LEADER_ROLE;
    const current = await this.read(role);
    if (!current || current.nodeId !== body.nodeId) return null;
    if (current.sessionId !== (body.sessionId ?? null)) return null;

    const now = Date.now();
    const leaseSeconds = normalizeLeaseSeconds(body.leaseSeconds);
    const lease: StoredLease = {
      ...current,
      heartbeatAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseSeconds * 1000).toISOString(),
    };

    await this.ctx.storage.put(keyFor(role), lease);
    return lease;
  }

  /**
   * Release the role. Only the holding (nodeId, sessionId) pair may release;
   * a different node or a newer session of the same node is a no-op.
   */
  async release(body: {
    nodeId: string;
    role?: string;
    sessionId?: string | null;
  }): Promise<boolean> {
    if (!body?.nodeId) throw new Error('[meta/coordinator] nodeId is required for release');

    const role = body.role ?? META_LEADER_ROLE;
    const current = await this.read(role);
    if (!current || current.nodeId !== body.nodeId) return false;
    if (current.sessionId !== (body.sessionId ?? null)) return false;

    await this.ctx.storage.put(keyFor(role), {
      role,
      nodeId: null,
      nodeDescriptor: null,
      sessionId: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      metadata: current.metadata,
    } satisfies StoredLease);
    return true;
  }

  /**
   * Inspect the lease without mutating it. Returns null when unheld.
   *
   * Parity note: an *expired but unreleased* lease is still returned, matching
   * `describeLease()` in daemon/leader.ts, which filters only on `node_id`.
   * Callers must not treat a non-null result as proof of live leadership.
   */
  async describe(role: string = META_LEADER_ROLE): Promise<StoredLease | null> {
    const current = await this.read(role);
    return current?.nodeId ? current : null;
  }
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('invalid JSON body');
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
