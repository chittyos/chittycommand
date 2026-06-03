-- ChittyCommand Documents: add unique index on r2_key
-- Migration: 0016_documents_r2key_unique
-- Date: 2026-05-05
-- Required for ON CONFLICT (r2_key) DO NOTHING in batch upload upsert.
-- Partial index excludes NULL rows (some legacy documents may not have an r2_key).

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_documents_r2key_unique
  ON cc_documents (r2_key)
  WHERE r2_key IS NOT NULL;

COMMIT;
