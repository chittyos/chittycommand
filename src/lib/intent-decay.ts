/**
 * Roux Intent Decay (Phase 2.5)
 *
 * Expires stale 'pending' roux_ingest intents that have outlived their TTL.
 * Sets status='expired' and stamps decayed_at. Refusing to fan out indefinitely
 * caps unbounded queue growth from Gmail ingest sources that the user never
 * triages, and lets the refreshed partial unique index (migration 0018) free
 * the message_id slot for a future re-ingest if the user re-enables the source.
 *
 * Only operates on:
 *   - status = 'pending'
 *   - intent_type = 'roux_ingest'
 *   - dispatched_task_id IS NULL (never been claimed/dispatched)
 *   - expires_at <= NOW(), OR (expires_at IS NULL AND created_at older than TTL)
 *
 * @canonical-uri chittycanon://core/services/chittycommand/workspace-studio
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface DecayResult {
  /** Number of intents transitioned pending → expired. */
  expired: number;
  /** Number of candidate rows the UPDATE inspected (caller-visible == expired). */
  scanned: number;
  /** ISO-8601 timestamp of the run start. */
  runAt: string;
}

export interface DecayOptions {
  /** TTL in days for roux_ingest intents. Default: 30. */
  ttlDays?: number;
  /** Maximum rows to expire in a single call. Default: 500. */
  batchLimit?: number;
}

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 500;

/**
 * Expire stale pending roux_ingest intents.
 *
 * Safe to call concurrently from multiple cron leaders — the UPDATE is atomic
 * per row, and rows that change state mid-run are simply skipped (the WHERE
 * clause requires status='pending').
 */
export async function decayStaleRouxIntents(
  sql: NeonQueryFunction<false, false>,
  options: DecayOptions = {},
): Promise<DecayResult> {
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const runAt = new Date().toISOString();

  // Select the oldest stale candidates inside a CTE to honor the LIMIT, then
  // UPDATE only those rows. Postgres doesn't allow ORDER BY + LIMIT directly
  // on UPDATE, so the CTE pattern keeps the operation bounded.
  const rows = await sql`
    WITH candidates AS (
      SELECT id
      FROM cc_intents
      WHERE status = 'pending'
        AND intent_type = 'roux_ingest'
        AND dispatched_task_id IS NULL
        AND (
          expires_at <= NOW()
          OR (expires_at IS NULL AND created_at < NOW() - (${ttlDays} || ' days')::interval)
        )
      ORDER BY COALESCE(expires_at, created_at) ASC
      LIMIT ${batchLimit}
    )
    UPDATE cc_intents
       SET status     = 'expired',
           decayed_at = ${runAt}::timestamptz,
           updated_at = NOW()
      FROM candidates
     WHERE cc_intents.id = candidates.id
       AND cc_intents.status = 'pending'
    RETURNING cc_intents.id
  `;

  const expired = rows.length;
  return { expired, scanned: expired, runAt };
}

/**
 * Compute the canonical expires_at for a roux_ingest intent given its
 * creation time. Exposed so the ingest path (workspace-studio) can stamp
 * expires_at at insert time rather than relying on the fallback created_at
 * comparison.
 */
export function computeRouxExpiresAt(
  createdAt: Date = new Date(),
  ttlDays: number = DEFAULT_TTL_DAYS,
): Date {
  const ms = createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000;
  return new Date(ms);
}
