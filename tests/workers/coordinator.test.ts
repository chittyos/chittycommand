import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CommandCoordinator } from '../../meta/coordinator';
import { META_LEADER_ROLE } from '../../meta/coordinator';

/**
 * Real Durable Object, real DO storage, real workerd. No mocks.
 *
 * Each test uses a uniquely-named instance so state never leaks between cases.
 */
// vitest-pool-workers types `env` via an ambient alias that cannot be
// augmented, so the binding is typed here rather than in a .d.ts.
const bindings = env as unknown as {
  COMMAND_COORDINATOR: DurableObjectNamespace<CommandCoordinator>;
};

function instance(name: string) {
  const ns = bindings.COMMAND_COORDINATOR;
  return ns.get(ns.idFromName(name));
}

const run = <T>(name: string, fn: (c: CommandCoordinator) => Promise<T>) =>
  runInDurableObject(instance(name), fn);

describe('CommandCoordinator lease arbitration', () => {
  it('grants an unheld role to the first claimant', async () => {
    const lease = await run('t-first', (c) => c.claim({ nodeId: 'node-a', sessionId: 's1' }));
    expect(lease).not.toBeNull();
    expect(lease!.nodeId).toBe('node-a');
    expect(lease!.role).toBe(META_LEADER_ROLE);
    expect(Date.parse(lease!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('refuses a second node while the incumbent lease is live', async () => {
    const granted = await run('t-excl', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return c.claim({ nodeId: 'node-b', sessionId: 's2' });
    });
    expect(granted).toBeNull();
  });

  it('lets the same node re-claim (idempotent restart)', async () => {
    const lease = await run('t-reclaim', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
    });
    expect(lease?.nodeId).toBe('node-a');
  });

  it('allows takeover once the incumbent lease has expired', async () => {
    const lease = await run('t-takeover', async (c) => {
      // 1s is the minimum the normalizer permits.
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      return c.claim({ nodeId: 'node-b', sessionId: 's2' });
    });
    expect(lease?.nodeId).toBe('node-b');
  });

  it('rejects a heartbeat from a node that does not hold the role', async () => {
    const beat = await run('t-hb-node', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return c.heartbeat({ nodeId: 'node-b', sessionId: 's2' });
    });
    expect(beat).toBeNull();
  });

  it('rejects a heartbeat from a stale session of the holding node', async () => {
    // codex-p2 PR#101 finding-5: a restarted process reusing nodeId must not
    // heartbeat over a fresh leader.
    const beat = await run('t-hb-session', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 'new-session', leaseSeconds: 60 });
      return c.heartbeat({ nodeId: 'node-a', sessionId: 'old-session' });
    });
    expect(beat).toBeNull();
  });

  it('re-bases expiry on now, not on claimedAt, when heartbeating', async () => {
    // Same leaseSeconds on both calls: if expiry were computed as
    // claimedAt + leaseSeconds, `after` would equal `before` and this fails.
    const { before, after } = await run('t-hb-extend', async (c) => {
      const first = await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      await new Promise((r) => setTimeout(r, 60));
      const beat = await c.heartbeat({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return { before: first!.leaseExpiresAt!, after: beat!.leaseExpiresAt! };
    });
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('rejects a release from a stale session of the holding node', async () => {
    // codex-p2 PR#101 finding-2.
    const released = await run('t-rel-session', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 'new-session', leaseSeconds: 60 });
      return c.release({ nodeId: 'node-a', sessionId: 'old-session' });
    });
    expect(released).toBe(false);
  });

  it('frees the role on a valid release, making it immediately claimable', async () => {
    const { released, next } = await run('t-rel-ok', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      const ok = await c.release({ nodeId: 'node-a', sessionId: 's1' });
      return { released: ok, next: await c.claim({ nodeId: 'node-b', sessionId: 's2' }) };
    });
    expect(released).toBe(true);
    expect(next?.nodeId).toBe('node-b');
  });

  it('describe returns null when unheld and the holder when held', async () => {
    const { empty, held } = await run('t-describe', async (c) => {
      const before = await c.describe();
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return { empty: before, held: await c.describe() };
    });
    expect(empty).toBeNull();
    expect(held?.nodeId).toBe('node-a');
  });

  it('isolates roles from one another', async () => {
    const other = await run('t-roles', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return c.claim({ nodeId: 'node-b', sessionId: 's2', role: 'ingest-leader' });
    });
    expect(other?.nodeId).toBe('node-b');
    expect(other?.role).toBe('ingest-leader');
  });

  it('clamps lease length to the permitted bounds', async () => {
    const { tiny, huge } = await run('t-clamp', async (c) => {
      const a = await c.claim({ nodeId: 'n1', sessionId: 's', leaseSeconds: -5 });
      await c.release({ nodeId: 'n1', sessionId: 's' });
      const b = await c.claim({ nodeId: 'n2', sessionId: 's', leaseSeconds: 999_999 });
      return { tiny: a!, huge: b! };
    });
    // -5 is invalid → falls back to the 30s default.
    const tinyMs = Date.parse(tiny.leaseExpiresAt!) - Date.parse(tiny.heartbeatAt!);
    expect(tinyMs).toBe(30_000);
    // 999999s clamps to the 3600s ceiling.
    const hugeMs = Date.parse(huge.leaseExpiresAt!) - Date.parse(huge.heartbeatAt!);
    expect(hugeMs).toBe(3_600_000);
  });

  it('rejects a claim with no nodeId', async () => {
    await expect(
      run('t-novalid', (c) => c.claim({ nodeId: '' })),
    ).rejects.toThrow(/nodeId is required/);
  });

  it('clamps a sub-second lease up to the 1s minimum', async () => {
    const lease = await run('t-clamp-min', (c) =>
      c.claim({ nodeId: 'n1', sessionId: 's', leaseSeconds: 0.5 }),
    );
    expect(Date.parse(lease!.leaseExpiresAt!) - Date.parse(lease!.heartbeatAt!)).toBe(1_000);
  });

  it('refuses a release from a node that does not hold the role', async () => {
    const released = await run('t-rel-othernode', async (c) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      return c.release({ nodeId: 'node-b', sessionId: 's1' });
    });
    expect(released).toBe(false);
  });

  it('treats an omitted sessionId as null, matching SQL IS NOT DISTINCT FROM', async () => {
    const beat = await run('t-session-omitted', async (c) => {
      await c.claim({ nodeId: 'node-a', leaseSeconds: 60 });
      return c.heartbeat({ nodeId: 'node-a' });
    });
    expect(beat).not.toBeNull();
  });

  it('recovers a role whose stored expiry is corrupt instead of deadlocking', async () => {
    // Date.parse('not-a-date') is NaN and every NaN comparison is false, so a
    // naive `expiresAt < now` check would make this role unclaimable forever.
    const lease = await runInDurableObject(instance('t-corrupt'), async (c, state) => {
      await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 60 });
      const stored = await state.storage.get<Record<string, unknown>>(
        `lease:${META_LEADER_ROLE}`,
      );
      await state.storage.put(`lease:${META_LEADER_ROLE}`, {
        ...stored,
        leaseExpiresAt: 'not-a-date',
      });
      return c.claim({ nodeId: 'node-b', sessionId: 's2' });
    });
    expect(lease?.nodeId).toBe('node-b');
  });
});

/**
 * HTTP seam. The suite above calls the class directly via runInDurableObject,
 * which leaves fetch() — path parsing, the method switch, error mapping, and
 * the JSON envelopes the daemon client unwraps — entirely uncovered.
 */
describe('CommandCoordinator HTTP surface', () => {
  const call = (name: string, method: string, path: string, body?: unknown) =>
    instance(name).fetch(
      new Request(`https://coordinator/api/meta/coordinator${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('claims over HTTP and returns the lease as JSON', async () => {
    const res = await call('h-claim', 'POST', '/claim', { nodeId: 'node-a', sessionId: 's1' });
    expect(res.status).toBe(200);
    expect((await res.json<{ nodeId: string }>()).nodeId).toBe('node-a');
  });

  it('returns a bare null body for an unheld describe — the client no-lease signal', async () => {
    const res = await call('h-describe', 'GET', '/describe');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('wraps release in a {released} envelope', async () => {
    await call('h-release', 'POST', '/claim', { nodeId: 'node-a', sessionId: 's1' });
    const res = await call('h-release', 'POST', '/release', { nodeId: 'node-a', sessionId: 's1' });
    expect(await res.json()).toEqual({ released: true });
  });

  it('404s an unknown path', async () => {
    const res = await call('h-404', 'POST', '/nope');
    expect(res.status).toBe(404);
  });

  it('404s a correct path under the wrong method', async () => {
    const res = await call('h-method', 'GET', '/claim');
    expect(res.status).toBe(404);
  });

  it('maps a malformed body to a 400 rather than a 500', async () => {
    const res = await instance('h-badjson').fetch(
      new Request('https://coordinator/api/meta/coordinator/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('coordinator_error');
  });

  it('does not dispatch a mutation from a path that does not name it', async () => {
    // Regression: a greedy /^.*\/coordinator/ matched the LAST occurrence, so
    // this executed `release`.
    await call('h-greedy', 'POST', '/claim', { nodeId: 'node-a', sessionId: 's1' });
    const res = await call('h-greedy', 'POST', '/a/coordinator/release', {
      nodeId: 'node-a',
      sessionId: 's1',
    });
    expect(res.status).toBe(404);

    const still = await call('h-greedy', 'GET', '/describe');
    expect((await still.json<{ nodeId: string } | null>())?.nodeId).toBe('node-a');
  });
});
