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

  it('extends the expiry on a valid heartbeat', async () => {
    const { before, after } = await run('t-hb-extend', async (c) => {
      const first = await c.claim({ nodeId: 'node-a', sessionId: 's1', leaseSeconds: 1 });
      await new Promise((r) => setTimeout(r, 50));
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
});
