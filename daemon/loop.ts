/**
 * Cluster daemon — persistent leader loop.
 *
 * Lifecycle:
 *   1. Try to claim leadership (claimLeadership).
 *   2. On success: enter inner loop.
 *      a. Heartbeat the lease every `heartbeatMs`.
 *      b. Reclaim stuck intents (idempotent).
 *      c. Claim the next pending Intent (claimNextIntent).
 *      d. Drive it through `executeIntent`, which dispatches via the executor
 *         registry, applies the second sovereignty gate, and atomically updates
 *         `cc_intents.status` + writes `cc_actions_log`.
 *   3. On failure / lost lease: park `parkMs`, then retry.
 *   4. On AbortSignal: lease released, loop exits.
 *
 * The loop classifies four outcomes from `executeIntent`'s `ExecutorResult`:
 *
 *   | Outcome                         | ok    | replayed | Action                            |
 *   |---------------------------------|-------|----------|-----------------------------------|
 *   | Fresh successful execution      | true  | false    | Heartbeat, count, continue        |
 *   | Replayed (terminal audit exists)| true  | true     | Log, continue, no count, no retry |
 *   | Sovereignty refusal             | false | false    | Log refusal, continue, no backoff |
 *   | Executor error                  | false | false    | Log error, bounded exp backoff    |
 *
 * Refusals are distinguished from generic executor errors by inspecting
 * `result.error` for the canonical refusal prefixes emitted by
 * `meta/executors/dispatch.ts` (`sovereignty re-reckon:` and
 * `sovereignty snapshot stale ...`).
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

import {
  claimLeadership,
  heartbeat,
  releaseLeadership,
  META_LEADER_ROLE,
  type LeaderEnv,
} from './leader';
import {
  claimNextIntent,
  executeIntent,
  reclaimStuckIntents,
  type Intent,
  type IntentEnv,
} from '../meta/intent';
import type { ExecutorResult } from '../meta/executors/types';

export type LoopEnv = LeaderEnv & IntentEnv & Record<string, unknown>;

export interface RunLeaderLoopOptions {
  /** ChittyID of the running node (Location type — L). */
  nodeId: string;
  /** Human-readable node descriptor (hostname). */
  nodeDescriptor?: string;
  /** Session id (process id, PID + start time, etc.) */
  sessionId?: string;
  /** Lease length seconds. Default 30. */
  leaseSeconds?: number;
  /** Heartbeat interval ms. Default 10000. */
  heartbeatMs?: number;
  /** Park-and-retry interval ms when not leader. Default 5000. */
  parkMs?: number;
  /** Initial backoff ms for executor errors. Default 1000. */
  errorBackoffMs?: number;
  /** Max backoff ms cap for executor errors. Default 30000. */
  errorBackoffMaxMs?: number;
  /** Optional cap on intent iterations — useful for tests. */
  maxIntents?: number;
  /**
   * Optional cap on loop iterations regardless of intents processed — useful
   * for tests when the queue might drain to empty before reaching maxIntents.
   */
  maxIterations?: number;
  /** AbortSignal to terminate the loop cleanly. */
  signal?: AbortSignal;
  /** Role to claim. Defaults to META_LEADER_ROLE. */
  role?: string;
  /** Optional log sink. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Optional override for actorChittyId passed to executeIntent. When omitted,
   * the dispatcher reads it from `intent.metadata.actorChittyId` /
   * `intent.metadata.ownerChittyId` if needed.
   */
  actorChittyId?: string;
}

export interface RunLeaderLoopResult {
  intentsProcessed: number;
  intentsReplayed: number;
  intentsRefused: number;
  intentsErrored: number;
  reason: 'aborted' | 'maxIntents' | 'maxIterations' | 'leaseLost' | 'error';
  error?: string;
}

const noopLog = (_msg: string, _meta?: Record<string, unknown>) => {};

export async function runLeaderLoop(
  env: LoopEnv,
  options: RunLeaderLoopOptions,
): Promise<RunLeaderLoopResult> {
  const log = options.log ?? noopLog;
  const role = options.role ?? META_LEADER_ROLE;
  const leaseSeconds = options.leaseSeconds ?? 30;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const parkMs = options.parkMs ?? 5_000;
  const signal = options.signal;

  const counters = {
    intentsProcessed: 0,
    intentsReplayed: 0,
    intentsRefused: 0,
    intentsErrored: 0,
  };

  while (!signal?.aborted) {
    // 1. Acquire leadership.
    let lease;
    try {
      lease = await claimLeadership(env, {
        nodeId: options.nodeId,
        nodeDescriptor: options.nodeDescriptor,
        sessionId: options.sessionId,
        leaseSeconds,
        role,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('claimLeadership_error', { error: msg });
      await sleep(parkMs, signal);
      continue;
    }

    if (!lease) {
      log('not_leader_parking', { parkMs });
      await sleep(parkMs, signal);
      continue;
    }

    log('leader_acquired', {
      role,
      nodeId: options.nodeId,
      expiresAt: lease.leaseExpiresAt,
    });

    // 2. Inner loop: heartbeat + drain intents until lease lost or aborted.
    const innerResult = await innerLoop(env, options, role, leaseSeconds, heartbeatMs, counters);

    if (
      innerResult.reason === 'aborted' ||
      innerResult.reason === 'maxIntents' ||
      innerResult.reason === 'maxIterations'
    ) {
      // Best-effort release on clean exit — pass sessionId so the release
      // refuses to clear a newer leader's lease.
      try {
        await releaseLeadership(env, options.nodeId, {
          role,
          sessionId: options.sessionId,
        });
      } catch (err) {
        log('release_error', { error: err instanceof Error ? err.message : String(err) });
      }
      return { ...counters, reason: innerResult.reason };
    }

    if (innerResult.reason === 'error') {
      log('inner_loop_error', { error: innerResult.error });
      await sleep(parkMs, signal);
      continue;
    }

    // leaseLost — park then retry claim.
    log('lease_lost_parking', { parkMs });
    await sleep(parkMs, signal);
  }

  return { ...counters, reason: 'aborted' };
}

interface Counters {
  intentsProcessed: number;
  intentsReplayed: number;
  intentsRefused: number;
  intentsErrored: number;
}

async function innerLoop(
  env: LoopEnv,
  options: RunLeaderLoopOptions,
  role: string,
  leaseSeconds: number,
  heartbeatMs: number,
  counters: Counters,
): Promise<{ reason: 'aborted' | 'maxIntents' | 'maxIterations' | 'leaseLost' | 'error'; error?: string }> {
  const log = options.log ?? noopLog;
  const signal = options.signal;
  const errorBackoffStartMs = options.errorBackoffMs ?? 1_000;
  const errorBackoffMaxMs = options.errorBackoffMaxMs ?? 30_000;
  let currentErrorBackoffMs = errorBackoffStartMs;
  let lastHeartbeat = Date.now();
  let iterations = 0;

  // Heartbeat cadence inside executeIntent() — half the lease so a slow
  // dispatch can't let the lease lapse mid-flight.
  const innerHeartbeatMs = Math.max(1_000, Math.floor((leaseSeconds * 1000) / 2));

  while (!signal?.aborted) {
    iterations += 1;
    if (options.maxIterations && iterations > options.maxIterations) {
      return { reason: 'maxIterations' };
    }

    // Heartbeat if due. Session-scoped so a restarted process can't extend
    // a lease that already belongs to a newer leader.
    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      try {
        const renewed = await heartbeat(env, options.nodeId, {
          role,
          leaseSeconds,
          sessionId: options.sessionId,
        });
        if (!renewed) {
          return { reason: 'leaseLost' };
        }
        lastHeartbeat = Date.now();
        log('heartbeat_ok', { expiresAt: renewed.leaseExpiresAt });
      } catch (err) {
        return {
          reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Reclaim intents stuck past 2x the lease window before claiming new work.
    try {
      const reclaimed = await reclaimStuckIntents(env, leaseSeconds * 2);
      if (reclaimed > 0) log('intents_reclaimed', { count: reclaimed });
    } catch (err) {
      log('reclaim_error', { error: err instanceof Error ? err.message : String(err) });
    }

    // Claim one intent. The intent moves pending -> claimed atomically;
    // executeIntent picks it up from there.
    let intent: Intent | null;
    try {
      intent = await claimNextIntent(env);
    } catch (err) {
      return {
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!intent) {
      // Nothing to do — short idle nap, but never longer than the heartbeat
      // window so we don't lose the lease while idle.
      await sleep(Math.min(1000, heartbeatMs / 2), signal);
      continue;
    }

    log('intent_claimed', {
      intentId: intent.id,
      intentType: intent.intentType,
    });
    // Pre-execution heartbeat marker. The DB heartbeat is driven by
    // `lastHeartbeat`; this log line marks the boundary for the operational
    // record.
    log('intent_heartbeat_before', { intentId: intent.id });

    // Background heartbeat ticker covering the dispatch() span. Uses the
    // current session token so the heartbeat is rejected if a newer leader
    // has taken over.
    const dispatchHeartbeat = setInterval(() => {
      heartbeat(env, options.nodeId, {
        role,
        leaseSeconds,
        sessionId: options.sessionId,
      })
        .then((renewed) => {
          if (renewed) {
            lastHeartbeat = Date.now();
            log('exec_heartbeat_ok', { expiresAt: renewed.leaseExpiresAt });
          } else {
            log('exec_heartbeat_lost', { intentId: intent!.id });
          }
        })
        .catch((err) => {
          log('exec_heartbeat_error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, innerHeartbeatMs);

    let result: ExecutorResult;
    try {
      result = await executeIntent(env, intent.id, {
        actorChittyId: options.actorChittyId,
      });
    } catch (err) {
      // executeIntent / dispatch threw unhandled (e.g., DB connectivity, no
      // executor registered — a wiring bug). cc_intents was NOT necessarily
      // flipped to terminal; leave it as-is so reclaimStuckIntents recovers.
      const msg = err instanceof Error ? err.message : String(err);
      counters.intentsErrored += 1;
      log('intent_dispatch_threw', { intentId: intent.id, error: msg });
      clearInterval(dispatchHeartbeat);
      log('intent_heartbeat_after', { intentId: intent.id, outcome: 'threw' });
      await sleep(currentErrorBackoffMs, signal);
      currentErrorBackoffMs = Math.min(currentErrorBackoffMs * 2, errorBackoffMaxMs);
      continue;
    } finally {
      clearInterval(dispatchHeartbeat);
    }

    // Classify the outcome.
    if (result.ok && result.replayed) {
      // Replay short-circuit: prior terminal audit row exists. Not an error,
      // not new work — just continue. Do NOT bump processed counter; do NOT
      // trigger error backoff.
      counters.intentsReplayed += 1;
      log('intent_replayed', {
        intentId: intent.id,
        idempotencyKey: result.idempotencyKey,
        actionLogId: result.actionLogId,
      });
      currentErrorBackoffMs = errorBackoffStartMs;
    } else if (result.ok) {
      // Fresh successful execution.
      counters.intentsProcessed += 1;
      log('intent_completed', {
        intentId: intent.id,
        idempotencyKey: result.idempotencyKey,
        actionLogId: result.actionLogId,
      });
      currentErrorBackoffMs = errorBackoffStartMs;
    } else if (isSovereigntyRefusal(result.error)) {
      // executeIntent already flipped cc_intents to 'failed' via dispatch's
      // refusal path. Log + continue, no backoff (refusals are a valid
      // steady-state outcome, not a transient fault).
      counters.intentsRefused += 1;
      log('intent_refused', {
        intentId: intent.id,
        reason: result.error,
        actionLogId: result.actionLogId,
      });
      currentErrorBackoffMs = errorBackoffStartMs;
    } else {
      // Executor error path (payload validation failure, downstream API
      // failure, domain failure like "Obligation not found"). cc_intents was
      // flipped to 'failed' inside executeIntent. Apply bounded exponential
      // backoff so a stream of failing intents doesn't hot-loop the daemon.
      counters.intentsErrored += 1;
      log('intent_failed', {
        intentId: intent.id,
        error: result.error,
        actionLogId: result.actionLogId,
      });
      await sleep(currentErrorBackoffMs, signal);
      currentErrorBackoffMs = Math.min(currentErrorBackoffMs * 2, errorBackoffMaxMs);
    }

    log('intent_heartbeat_after', {
      intentId: intent.id,
      ok: result.ok,
      replayed: !!result.replayed,
    });

    const totalTerminal =
      counters.intentsProcessed +
      counters.intentsReplayed +
      counters.intentsRefused +
      counters.intentsErrored;
    if (options.maxIntents && totalTerminal >= options.maxIntents) {
      return { reason: 'maxIntents' };
    }
  }

  return { reason: 'aborted' };
}

/**
 * Identify sovereignty refusals emitted by meta/executors/dispatch.ts.
 * Canonical refusal strings:
 *   - "sovereignty snapshot stale and no actorChittyId available for re-reckon"
 *   - "sovereignty re-reckon: requires_human (...)"
 *   - "sovereignty re-reckon: blocked (...)"
 */
function isSovereigntyRefusal(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.startsWith('sovereignty re-reckon:') ||
    error.startsWith('sovereignty snapshot stale')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
