-- 0017_roux_ingest_idempotency.sql
--
-- Partial unique index on Gmail message_id for intent_type='roux_ingest'.
-- Backs the atomic INSERT ... ON CONFLICT DO NOTHING idempotency guard in
-- src/routes/workspace-studio.ts. Without this, two concurrent Google retries
-- of the same Gmail event can both pass a SELECT pre-check before either
-- INSERT lands, producing duplicate intents and double-fanned-out side
-- effects.
--
-- Partial (WHERE intent_type = 'roux_ingest') so other intent_types that
-- happen to carry payload->source->>message_id (e.g. future SMS sources) are
-- not constrained.
--
-- @canon: chittycanon://core/services/chittycommand/workspace-studio

CREATE UNIQUE INDEX IF NOT EXISTS cc_intents_roux_ingest_message_id_uidx
  ON cc_intents ((payload->'source'->>'message_id'))
  WHERE intent_type = 'roux_ingest'
    AND payload->'source'->>'message_id' IS NOT NULL;
