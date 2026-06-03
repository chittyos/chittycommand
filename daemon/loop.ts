/**
 * Cluster daemon — persistent leader loop skeleton.
 *
 * Lifecycle:
 *   1. Try to claim leadership (claimLeadership).
 *   2. On success: enter inner loop.
 *      a. Heartbeat the lease every `heartbeatMs`.
 *      b. Claim the next pending Intent (claimNextIntent) and dispatch it
 *         through the supplied executor.
 *      c. Mark intent done/failed.
 *   3. On failure / lost lease: park `parkMs`, then retry.
 *   4. On AbortSignal: heartbeat is interrupted, lease is released, loop exits.
 *
 * The executor is injected so this PR introduces no coupling to the existing
 * ActionAgent — the wiring to ActionAgent comes in a follow-up PR per
 * ADR-001's out-of-scope list.
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
  completeIntent,
  failIntent,
  markIntentDispatched,
  reclaimStuckIntents,
  type Intent,
  type IntentEnv,
} from '../meta/intent';

export type LoopEnv = LeaderEnv & IntentEnv;

export interface IntentExecutor {
  /**
   * Execute one claimed Intent. Implementations should be idempotent and
   * return a `dispatchedTaskId` (e.g. an ActionAgent task ID) so the loop
   * can persist it. Throwing causes the loop to mark the intent failed.
   */
  (intent: Intent): Promise<{ dispatchedTaskId: string }>;
}

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
  /** Optional cap on intent iterations — useful for tests. */
  maxIntents?: number;
  /** AbortSignal to terminate the loop cleanly. */
  signal?: AbortSignal;
  /** Role to claim. Defaults to META_LEADER_ROLE. */
  role?: string;
  /** Optional log sink. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Executor for claimed intents. */
  executor: IntentExecutor;
}

export interface RunLeaderLoopResult {
  intentsProcessed: number;
  reason: 'aborted' | 'maxIntents' | 'leaseLost' | 'error';
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

  let intentsProcessed = 0;

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

    log('leader_acquired', { role, nodeId: options.nodeId, expiresAt: lease.leaseExpiresAt });

    // 2. Inner loop: heartbeat + drain intents until lease lost or aborted.
    const innerResult = await innerLoop(env, options, role, leaseSeconds, heartbeatMs, intentsProcessed);
    intentsProcessed = innerResult.intentsProcessed;

    if (innerResult.reason === 'aborted' || innerResult.reason === 'maxIntents') {
      // Best-effort release on clean exit — pass sessionId so the release
      // refuses to clear a newer leader's lease (fixes codex-p2 PR#101 finding-2).
      try {
        await releaseLeadership(env, options.nodeId, { role, sessionId: options.sessionId });
      } catch (err) {
        log('release_error', { error: err instanceof Error ? err.message : String(err) });
      }
      return { intentsProcessed, reason: innerResult.reason };
    }

    if (innerResult.reason === 'error') {
      log('inner_loop_error', { error: innerResult.error });
      // Park briefly, then attempt to reclaim.
      await sleep(parkMs, signal);
      continue;
    }

    // leaseLost — park then retry claim.
    log('lease_lost_parking', { parkMs });
    await sleep(parkMs, signal);
  }

  return { intentsProcessed, reason: 'aborted' };
}

async function innerLoop(
  env: LoopEnv,
  options: RunLeaderLoopOptions,
  role: string,
  leaseSeconds: number,
  heartbeatMs: number,
  startCount: number,
): Promise<{ intentsProcessed: number; reason: 'aborted' | 'maxIntents' | 'leaseLost' | 'error'; error?: string }> {
  const log = options.log ?? noopLog;
  const signal = options.signal;
  let intentsProcessed = startCount;
  let lastHeartbeat = Date.now();

  // Heartbeat cadence inside executor.execute() — half the lease so a slow
  // executor can't let the lease lapse mid-flight.
  // fixes codex-p2 PR#101 finding-3
  const innerHeartbeatMs = Math.max(1_000, Math.floor((leaseSeconds * 1000) / 2));

  while (!signal?.aborted) {
    // Heartbeat if due. Session-scoped so a restarted process can't extend
    // a lease that already belongs to a newer leader.
    // fixes codex-p2 PR#101 finding-5
    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      try {
        const renewed = await heartbeat(env, options.nodeId, {
          role,
          leaseSeconds,
          sessionId: options.sessionId,
        });
        if (!renewed) {
          return { intentsProcessed, reason: 'leaseLost' };
        }
        lastHeartbeat = Date.now();
        log('heartbeat_ok', { expiresAt: renewed.leaseExpiresAt });
      } catch (err) {
        return {
          intentsProcessed,
          reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Reclaim intents stuck in running/claimed past 2x the lease window before
    // we ask for new work. Idempotent and cheap; if nothing is stuck this is
    // a single UPDATE returning 0 rows.
    // fixes codex-p2 PR#101 finding-1
    try {
      const reclaimed = await reclaimStuckIntents(env, leaseSeconds * 2);
      if (reclaimed > 0) log('intents_reclaimed', { count: reclaimed });
    } catch (err) {
      log('reclaim_error', { error: err instanceof Error ? err.message : String(err) });
    }

    // Claim and dispatch one intent.
    let intent: Intent | null;
    try {
      intent = await claimNextIntent(env);
    } catch (err) {
      return {
        intentsProcessed,
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

    log('intent_claimed', { intentId: intent.id, intentType: intent.intentType });

    // Background heartbeat ticker covering the executor.execute() span.
    // Uses the current session token so the heartbeat is rejected if a newer
    // leader has taken over.
    // fixes codex-p2 PR#101 finding-3, finding-5
    const executorHeartbeat = setInterval(() => {
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

    try {
      const result = await options.executor(intent);
      await markIntentDispatched(env, intent.id, result.dispatchedTaskId);
      await completeIntent(env, intent.id);
      intentsProcessed += 1;
      log('intent_completed', { intentId: intent.id, dispatchedTaskId: result.dispatchedTaskId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failIntent(env, intent.id, msg).catch(() => {
        /* surface only the original error */
      });
      log('intent_failed', { intentId: intent.id, error: msg });
    } finally {
      clearInterval(executorHeartbeat);
    }

    if (options.maxIntents && intentsProcessed >= options.maxIntents) {
      return { intentsProcessed, reason: 'maxIntents' };
    }
  }

  return { intentsProcessed, reason: 'aborted' };
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
