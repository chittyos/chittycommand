-- 0020_v2_arch_strip.sql — ChittyCommand v2 Architecture: Strip local truth-owning tables
-- Migration: 0020_v2_arch_strip
-- Date: 2026-07-26
-- Ref: docs/ARCHITECTURE_V2.md — "ChittyCommand does not own truth"
--
-- Phase 1 of strip:
--   DROP: cc_disputes, cc_dispute_correspondence (truth moves to ChittyCases)
--   ADD:  cc_node_leases (cluster daemon leader election — local operational truth only)
--
-- SAFE: cc_disputes/cc_dispute_correspondence FKs were already removed from
-- cc_documents (linked_dispute_id → text) and cc_recommendations (dispute_id → text)
-- in the schema.ts refactor. This migration completes the DB side.
--
-- Apply:
--   psql "$DATABASE_URL" < migrations/0020_v2_arch_strip.sql

BEGIN;

-- ── Drop local dispute tables (truth moved to ChittyCases service) ──────────
-- These are dropped AFTER confirming no remaining FK references in prod.
-- Provenance references now use text canonical IDs (ChittyCases dispute ID).

DROP TABLE IF EXISTS cc_dispute_correspondence CASCADE;
DROP TABLE IF EXISTS cc_disputes CASCADE;

-- ── Node Leases (cluster daemon: leader election + heartbeat) ────────────────
-- One row per role. Atomic UPDATE ... RETURNING = election.
-- nodeId format: ChittyID Location type (VV-G-LLL-SSSS-L-YM-C-X)
CREATE TABLE IF NOT EXISTS cc_node_leases (
    role              TEXT PRIMARY KEY,        -- e.g. 'meta-orchestrator-leader'
    node_id           VARCHAR(64),             -- ChittyID of node holding lease, null when free
    node_descriptor   TEXT,                    -- free-form ops label (hostname, region)
    session_id        TEXT,                    -- process/session id for restart tracking
    claimed_at        TIMESTAMPTZ,
    heartbeat_at      TIMESTAMPTZ,
    lease_expires_at  TIMESTAMPTZ,
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_node_leases_node    ON cc_node_leases(node_id);
CREATE INDEX IF NOT EXISTS idx_cc_node_leases_expires ON cc_node_leases(lease_expires_at);

-- Seed the meta-orchestrator role row so the daemon can claim it without an INSERT race
INSERT INTO cc_node_leases (role, metadata)
VALUES ('meta-orchestrator-leader', '{"seeded_by": "0020_v2_arch_strip"}')
ON CONFLICT (role) DO NOTHING;

-- Shared timestamp trigger (idempotent)
CREATE OR REPLACE FUNCTION cc_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_node_leases_updated_at ON cc_node_leases;
CREATE TRIGGER cc_node_leases_updated_at BEFORE UPDATE ON cc_node_leases
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

COMMIT;
