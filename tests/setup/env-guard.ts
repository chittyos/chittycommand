/**
 * Vitest setupFile — runs inside every test worker, before any spec is imported.
 *
 * Eleven specs read `process.env.DATABASE_URL` directly, so the opt-in variable
 * is mapped onto it here rather than editing each one. When the opt-in variable
 * is absent, the ambient DATABASE_URL is deleted: that deletion is what makes
 * the control fail closed, because the specs' existing `!DATABASE_URL` skip
 * guards then do the right thing instead of silently targeting production.
 *
 * See db-guard.ts for why the ambient variable is not trusted.
 */
import { resolveTestDatabaseUrl } from './db-guard';

const testDatabaseUrl = resolveTestDatabaseUrl();

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
} else {
  delete process.env.DATABASE_URL;
}
