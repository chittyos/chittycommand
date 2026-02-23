import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../index';

export function getDb(env: Env): NeonQueryFunction<false, false> {
  // Prefer DATABASE_URL (direct Neon HTTP endpoint) over Hyperdrive (TCP proxy).
  // The neon() HTTP driver needs to reach Neon's REST API directly;
  // Hyperdrive's internal hostname only works for TCP-based drivers.
  const connectionString = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error('No database connection string available');
  }
  return neon(connectionString);
}

/**
 * Type-narrow Neon query results to a specific row shape.
 *
 * This is the single sanctioned cast point for Neon's untyped Row[] results.
 * The Neon HTTP driver returns Record<string, unknown>[] — this helper narrows
 * to a declared interface. Column mismatches will show as undefined at runtime
 * rather than compile-time, which is an accepted trade-off for raw SQL queries.
 */
export function typedRows<T>(rows: readonly Record<string, unknown>[]): T[] {
  return rows as unknown as T[];
}
