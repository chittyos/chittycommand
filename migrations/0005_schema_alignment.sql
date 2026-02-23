-- ChittyCommand Schema Alignment
-- Migration: 0005_schema_alignment
-- Date: 2026-02-09
-- Adds columns used by bridge integrations and Plaid sync

BEGIN;

-- cc_transactions: bridge code uses source_id (not source_tx_id) and counterparty
ALTER TABLE cc_transactions ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE cc_transactions ADD COLUMN IF NOT EXISTS counterparty TEXT;
CREATE INDEX IF NOT EXISTS idx_cc_transactions_source ON cc_transactions(source, source_id);

-- cc_documents: bridge code stores ledger_evidence_id in metadata
ALTER TABLE cc_documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- cc_actions_log: obligation pay action stores charge_id in metadata
ALTER TABLE cc_actions_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Backfill source_id from source_tx_id where it exists
UPDATE cc_transactions SET source_id = source_tx_id WHERE source_id IS NULL AND source_tx_id IS NOT NULL;

COMMIT;
