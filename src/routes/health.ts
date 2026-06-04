/**
 * /health — real-dependency probe handler.
 *
 * Extracted from src/index.ts so it can be unit/integration-tested in pure
 * Node without dragging in `cloudflare:`-namespaced imports (Agents SDK,
 * Durable Objects, etc.) that only resolve under wrangler/workerd.
 *
 * Probes (each per-dep timeout 2000ms; total ≤ ~5000ms via Promise.all):
 *   - db            SELECT 1 via Neon HTTP driver.  Critical: failure → 503.
 *   - chittyconnect GET ${CHITTYCONNECT_URL}/health.  Degraded if unreachable.
 *   - daemon        max(heartbeat_at) FROM cc_node_leases.  Stale if older than
 *                   2× daemon/loop.ts default heartbeatMs (10000ms → 20000ms).
 *                   Missing table → not_provisioned (degraded, not down) so
 *                   deploys against bases without #101 don't 503.
 *
 * Runs unauthenticated; does not touch auth middleware.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/health
 */

import { getDb } from '../lib/db';

export const SERVICE_VERSION = '0.1.0';
// daemon/loop.ts default heartbeatMs is 10000; flag stale at 2× = 20000ms.
const DAEMON_STALE_MS = 20_000;

export type HealthEnv = {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  CHITTYCONNECT_URL?: string;
};

export interface DbProbe {
  status: 'ok' | 'down';
  latency_ms: number;
  error?: string;
}
export interface ChittyConnectProbe {
  status: 'ok' | 'degraded' | 'down';
  latency_ms: number;
  error?: string;
}
export interface DaemonProbe {
  status: 'ok' | 'stale' | 'not_provisioned';
  newest_heartbeat_age_ms: number | null;
  error?: string;
}

export interface HealthBody {
  status: 'ok' | 'degraded' | 'down';
  service: 'chittycommand';
  version: string;
  timestamp: string;
  probes: { db: DbProbe; chittyconnect: ChittyConnectProbe; daemon: DaemonProbe };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDb(env: HealthEnv): Promise<DbProbe> {
  const t0 = Date.now();
  try {
    // Cast: HealthEnv is a narrow subset of the worker Env type and getDb
    // only reads DATABASE_URL / HYPERDRIVE.connectionString.
    const sql = getDb(env as unknown as Parameters<typeof getDb>[0]);
    await withTimeout(sql`SELECT 1 AS ok`, 2000, 'db');
    return { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    return {
      status: 'down',
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeChittyConnect(env: HealthEnv): Promise<ChittyConnectProbe> {
  const url = env.CHITTYCONNECT_URL;
  const t0 = Date.now();
  if (!url) {
    return { status: 'degraded', latency_ms: 0, error: 'CHITTYCONNECT_URL not configured' };
  }
  try {
    const r = await withTimeout(
      fetch(`${url.replace(/\/$/, '')}/health`, { headers: { accept: 'application/json' } }),
      2000,
      'chittyconnect',
    );
    return r.ok
      ? { status: 'ok', latency_ms: Date.now() - t0 }
      : { status: 'degraded', latency_ms: Date.now() - t0, error: `HTTP ${r.status}` };
  } catch (err) {
    return {
      status: 'degraded',
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeDaemon(env: HealthEnv): Promise<DaemonProbe> {
  try {
    const sql = getDb(env as unknown as Parameters<typeof getDb>[0]);
    const rows = (await withTimeout(
      // NOTE: cc_node_leases has no `released_at` column. Release is
      // represented by NULLing `heartbeat_at`/`lease_expires_at` in
      // daemon/leader.ts::releaseLeadership. We treat any row whose
      // heartbeat_at is non-null as a currently-held lease and take the
      // newest heartbeat across them.
      sql`SELECT EXTRACT(EPOCH FROM (NOW() - max(heartbeat_at))) * 1000 AS age_ms
          FROM cc_node_leases
          WHERE heartbeat_at IS NOT NULL`,
      2000,
      'daemon',
    )) as Array<{ age_ms: number | string | null }>;
    const raw = rows[0]?.age_ms;
    if (raw === null || raw === undefined) {
      return { status: 'stale', newest_heartbeat_age_ms: null };
    }
    const ageMs = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return {
      status: ageMs > DAEMON_STALE_MS ? 'stale' : 'ok',
      newest_heartbeat_age_ms: Math.round(ageMs),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cc_node_leases|relation .* does not exist|does not exist/i.test(msg)) {
      return { status: 'not_provisioned', newest_heartbeat_age_ms: null, error: msg };
    }
    return { status: 'stale', newest_heartbeat_age_ms: null, error: msg };
  }
}

export async function runHealthProbes(env: HealthEnv): Promise<{ body: HealthBody; httpStatus: 200 | 503 }> {
  const [db, chittyconnect, daemon] = await Promise.all([
    probeDb(env),
    probeChittyConnect(env),
    probeDaemon(env),
  ]);

  let status: HealthBody['status'] = 'ok';
  if (db.status === 'down') {
    status = 'down';
  } else if (
    chittyconnect.status === 'degraded' ||
    chittyconnect.status === 'down' ||
    daemon.status === 'stale' ||
    daemon.status === 'not_provisioned'
  ) {
    status = 'degraded';
  }

  const body: HealthBody = {
    status,
    service: 'chittycommand',
    version: SERVICE_VERSION,
    timestamp: new Date().toISOString(),
    probes: { db, chittyconnect, daemon },
  };

  return { body, httpStatus: status === 'down' ? 503 : 200 };
}
