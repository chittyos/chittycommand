-- Migration 0006: Consolidate source_tx_id → source_id
-- Resolves split-brain where both columns existed for the same purpose.

-- Ensure any remaining data in source_tx_id is copied to source_id
UPDATE cc_transactions SET source_id = source_tx_id WHERE source_id IS NULL AND source_tx_id IS NOT NULL;

-- Drop the old column
ALTER TABLE cc_transactions DROP COLUMN IF EXISTS source_tx_id;
