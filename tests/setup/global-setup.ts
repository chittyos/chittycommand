/**
 * Vitest globalSetup — applies SQL migrations against the disposable Neon
 * branch named by NEON_TEST_DATABASE_URL before any integration tests run, so
 * specs hitting a fresh branch don't fail `beforeAll` with
 * `relation "cc_*" does not exist`.
 *
 * The URL comes from db-guard.ts, never from the ambient DATABASE_URL — see
 * that file for why.
 *
 * The repo's migrations directory mixes two histories:
 *   1. drizzle-kit-generated migrations tracked in `migrations/meta/_journal.json`
 *      — the canonical schema as deployed.
 *   2. hand-rolled SQL files (0001_command_*, 0002_command_*, ..., 0015_*) that
 *      represent an earlier, alternative history of the same tables. These
 *      conflict with the drizzle path (e.g., 0005_schema_alignment.sql
 *      references the pre-consolidation `source_tx_id` column).
 *   3. Additive, post-consolidation hand-rolled files (0017+ onwards) that
 *      patch the drizzle schema with idempotency / decay columns the
 *      integration suite relies on.
 *
 * Strategy: apply (1) in journal order, then (3) in name order. We tolerate
 * "already exists" Postgres error codes so partially migrated branches
 * (e.g., parent branches where some journaled migrations were applied out of
 * band) converge cleanly. Everything else fails loudly.
 *
 * Skips entirely when NEON_TEST_DATABASE_URL is unset or SKIP_INTEGRATION=1.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { resolveTestDatabaseUrl } from './db-guard';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

// Post-consolidation, additive hand-rolled migrations that complement the
// journaled drizzle schema (not part of the alternative-history set).
const ADDITIVE_PREFIXES = ['0017_', '0018_', '0019_'];

// Postgres SQLSTATE codes for "this object already exists" — safe to skip
// when re-applying overlapping migration sets across branches.
const ALREADY_EXISTS_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (constraint, type, trigger, etc.)
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42723', // duplicate_function
  '42P16', // invalid_object_definition (e.g., duplicate index name)
]);

/**
 * Split a SQL script on top-level `;` terminators, respecting `$$ ... $$`
 * dollar-quoted blocks so semicolons inside PL/pgSQL function bodies don't
 * prematurely terminate a statement.
 */
function splitOnSemicolons(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '$' && sql[i + 1] === '$') {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    if (ch === ';' && !inDollar) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function applyFile(pool: Pool, file: string): Promise<void> {
  const path = join(MIGRATIONS_DIR, file);
  const body = readFileSync(path, 'utf8');

  // drizzle-kit migrations use `--> statement-breakpoint`; hand-rolled files
  // use bare `;` terminators.
  const statements = body.includes('--> statement-breakpoint')
    ? body.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    : splitOnSemicolons(body);

  let applied = 0;
  let skipped = 0;
  for (const stmt of statements) {
    if (!stmt.replace(/--.*$/gm, '').trim()) continue;
    try {
      await pool.query(stmt);
      applied++;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && ALREADY_EXISTS_CODES.has(code)) {
        skipped++;
        continue;
      }
      console.error(`[vitest globalSetup] failed applying ${file}:`, err);
      throw err;
    }
  }
  console.log(
    `[vitest globalSetup]   ${file} — ${applied} applied, ${skipped} skipped (already exists)`,
  );
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = resolveTestDatabaseUrl();
  const skip = process.env.SKIP_INTEGRATION === '1';

  if (!databaseUrl || skip) {
    console.log(
      `[vitest globalSetup] Skipping migrations (NEON_TEST_DATABASE_URL=${databaseUrl ? 'set' : 'unset'}, SKIP_INTEGRATION=${process.env.SKIP_INTEGRATION ?? 'unset'})`,
    );
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // 1. Apply journaled drizzle migrations in journal order.
    const journalPath = join(MIGRATIONS_DIR, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    console.log(
      `[vitest globalSetup] Applying ${journal.entries.length} journaled migrations…`,
    );
    for (const entry of journal.entries) {
      await applyFile(pool, `${entry.tag}.sql`);
    }

    // 2. Apply additive post-consolidation hand-rolled migrations.
    const additive = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && ADDITIVE_PREFIXES.some((p) => f.startsWith(p)))
      .sort();
    if (additive.length > 0) {
      console.log(
        `[vitest globalSetup] Applying ${additive.length} additive migration(s): ${additive.join(', ')}`,
      );
      for (const file of additive) {
        await applyFile(pool, file);
      }
    }

    console.log('[vitest globalSetup] migrations applied.');
  } finally {
    await pool.end();
  }
}
