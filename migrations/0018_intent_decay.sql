-- 0018_intent_decay.sql — Roux intent decay: expires_at / decayed_at + refreshed idempotency guard
-- Migration: 0018_intent_decay
-- Date: 2026-06-10
-- Phase 2.5 of ChittyRoux × Workspace Studio

BEGIN;

ALTER TABLE cc_intents
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decayed_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cc_intents_decay_scan
  ON cc_intents (expires_at)
  WHERE status = 'pending'
    AND intent_type = 'roux_ingest'
    AND dispatched_task_id IS NULL;

DROP INDEX IF EXISTS cc_intents_roux_ingest_message_id_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS cc_intents_roux_ingest_message_id_uidx
  ON cc_intents ((payload->'source'->>'message_id'))
  WHERE intent_type  = 'roux_ingest'
    AND payload->'source'->>'message_id' IS NOT NULL
    AND status       <> 'expired';

COMMIT;
