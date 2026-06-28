-- 0019_contextual_provenance.sql
--
-- Provenance + sensitivity columns for the contextual (digested comms) upstream.
--
-- ChittyTriage intake spine (W4c): contextual → chittyrouter classify →
-- chittycommand. Every row inferred from the contextual store is AI-derived
-- and MUST be distinguishable from human/source-backed records:
--   - source       = 'contextual'
--   - source_ref   = the contextual message id (ctx-msg-<id>) / ChittyID
--   - confidence   = classifier confidence (0..1)
--   - status       = 'candidate'  (NOT verified — AI/inference alone)
--   - sensitivity  = 'business' | 'legalink'  (per-edge Two-Space gate)
--
-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
-- @canon: chittycanon://core/services/chittycommand/contextual-ingest
--
-- Spine rule: a claim is `verified` only when >=1 NON-AI source backs it; AI /
-- inference alone => `candidate`. Conflicts never auto-resolve — they raise a
-- chittyagent-tasks item. See src/lib/contextual-ingest.ts.

-- ── cc_obligations: inferred bills/debts carry full provenance ──────────────
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS confidence numeric;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'business';

-- ── cc_recommendations: provenance so triage output is traceable to comms ──
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'business';

-- ── Dedup guard: one inferred obligation per contextual source_ref ─────────
-- Partial so it only constrains contextual-sourced rows; other upstreams
-- (quo, email_bills, manual) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS cc_obligations_contextual_source_ref_uidx
  ON cc_obligations (source_ref)
  WHERE source = 'contextual' AND source_ref IS NOT NULL;

-- ── Idempotency for contextual_ingest intents (mirrors 0017 roux_ingest) ───
-- Backs INSERT ... ON CONFLICT DO NOTHING so concurrent ingest runs of the
-- same contextual message collapse to one intent.
CREATE UNIQUE INDEX IF NOT EXISTS cc_intents_contextual_ingest_message_id_uidx
  ON cc_intents ((payload->'source'->>'message_id'))
  WHERE intent_type = 'contextual_ingest'
    AND payload->'source'->>'message_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_obligations_source ON cc_obligations (source, status);
