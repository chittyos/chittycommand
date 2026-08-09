/**
 * ChittyCommand cluster daemon — process entrypoint.
 *
 * Reads required environment, runs `runLeaderLoop`, and traps SIGTERM/SIGINT
 * so the lease is released cleanly before the process exits.
 *
 * This is the file launchd/systemd invokes via `node dist/daemon/entrypoint.js`.
 * It is intentionally thin: all logic lives in `daemon/loop.ts` and `daemon/leader.ts`.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/daemon-supervisor
 */

import { runLeaderLoop } from '../loop';
import { releaseLeadership, META_LEADER_ROLE } from '../leader';

interface RequiredEnv {
  NODE_CHITTY_ID: string;
  DATABASE_URL: string;
  NODE_DESCRIPTOR: string;
}

function readEnv(): RequiredEnv {
  const missing: string[] = [];
  const nodeId = process.env.NODE_CHITTY_ID;
  const dbUrl = process.env.DATABASE_URL;
  const descriptor = process.env.NODE_DESCRIPTOR ?? process.env.HOSTNAME ?? '';

  if (!nodeId) missing.push('NODE_CHITTY_ID');
  if (!dbUrl) missing.push('DATABASE_URL');
  if (!descriptor) missing.push('NODE_DESCRIPTOR or HOSTNAME');

  if (missing.length > 0) {
    process.stderr.write(
      `[chittycommand-daemon] fatal: missing required env: ${missing.join(', ')}\n`,
    );
    process.exit(2);
  }

  return {
    NODE_CHITTY_ID: nodeId!,
    DATABASE_URL: dbUrl!,
    NODE_DESCRIPTOR: descriptor,
  };
}

function log(msg: string, meta?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    svc: 'chittycommand-daemon',
    msg,
    ...(meta ?? {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const env = readEnv();
  const sessionId = `${process.pid}@${Date.now()}`;
  const controller = new AbortController();

  log('daemon_start', {
    nodeId: env.NODE_CHITTY_ID,
    descriptor: env.NODE_DESCRIPTOR,
    sessionId,
    role: META_LEADER_ROLE,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('signal_received', { signal });
    controller.abort();
    // Belt-and-suspenders release in case the loop is wedged before the
    // abort path reaches releaseLeadership. Pass sessionId — releaseLeadership
    // gates on session ownership (codex-p2 PR#101 finding-2), so omitting it
    // would no-op against a lease claimed with our sessionId.
    releaseLeadership({ DATABASE_URL: env.DATABASE_URL }, env.NODE_CHITTY_ID, {
      role: META_LEADER_ROLE,
      sessionId,
    })
      .then((released) => log('release_on_signal', { released }))
      .catch((err) =>
        log('release_on_signal_error', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // No executor callback is passed: as of PR #106 the leader loop dispatches
  // through the canonical executor registry (`meta/executors/*`) via
  // `executeIntent`, not an injected callback. This foundation entrypoint
  // imports no executor modules, so the registry is empty — every claimed
  // intent hits dispatch's "no executor registered" path and is routed to
  // `failed` (never silently `done`). That preserves the PR #105 Codex P1
  // safety property without a stub callback. Real executors self-register
  // once their modules are imported (mercury_payment lands in PR #108).
  try {
    const result = await runLeaderLoop(
      { DATABASE_URL: env.DATABASE_URL },
      {
        nodeId: env.NODE_CHITTY_ID,
        nodeDescriptor: env.NODE_DESCRIPTOR,
        sessionId,
        signal: controller.signal,
        log,
      },
    );
    log('daemon_loop_returned', { ...result });
  } catch (err) {
    log('daemon_fatal', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    log('daemon_exit', { exitCode: process.exitCode ?? 0 });
  }
}

main().catch((err) => {
  process.stderr.write(
    `[chittycommand-daemon] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
