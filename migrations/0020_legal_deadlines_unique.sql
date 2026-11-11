-- 0020_legal_deadlines_unique.sql — natural key for cc_legal_deadlines
-- Migration: 0020_legal_deadlines_unique
-- Date: 2026-11-11
--
-- cc_legal_deadlines (0002_command_legal) has no UNIQUE constraint, so every
-- `INSERT ... ON CONFLICT DO NOTHING` against it was a no-op and a repeated
-- court-docket sync duplicated every entry. This index gives the docket
-- read-back an idempotent conflict target:
--   ON CONFLICT (case_ref, deadline_type, deadline_date, title, entry_ordinal) DO NOTHING
--
-- entry_ordinal: a docket can carry two genuinely distinct entries with the
-- same date and text (e.g. two identical orders entered the same day). They
-- are real records, not duplicates; the read-back numbers repeats of
-- (deadline_date, title) within one push 1..n in push order, so both are kept
-- and a re-run of the same push still inserts nothing. Existing rows get 1.
--
-- Additive + idempotent. Registered in tests/setup/global-setup.ts.
-- If existing rows already collide on this key, CREATE UNIQUE INDEX fails
-- loudly; this migration deliberately does not delete legal records to make
-- room. Check first:
--   SELECT case_ref, deadline_type, deadline_date, title, entry_ordinal, count(*)
--   FROM cc_legal_deadlines GROUP BY 1,2,3,4,5 HAVING count(*) > 1;
--
-- Prod apply (the drizzle journal does not include this file):
--   psql "$DATABASE_URL" < migrations/0020_legal_deadlines_unique.sql

ALTER TABLE cc_legal_deadlines ADD COLUMN IF NOT EXISTS entry_ordinal INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS uq_cc_legal_deadlines_entry;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_legal_deadlines_entry
  ON cc_legal_deadlines (case_ref, deadline_type, deadline_date, title, entry_ordinal);
