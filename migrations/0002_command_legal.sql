-- ChittyCommand Legal & Disputes Schema
-- Migration: 0002_command_legal
-- Date: 2026-02-09

BEGIN;

-- Legal deadlines: court dates, filing deadlines
CREATE TABLE cc_legal_deadlines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_ref        TEXT NOT NULL,
    case_system     TEXT,
    deadline_type   TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    deadline_date   TIMESTAMPTZ NOT NULL,
    reminder_days   INTEGER[] DEFAULT '{7,3,1}',
    status          TEXT DEFAULT 'upcoming',
    urgency_score   INTEGER,
    evidence_db_ref TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_legal_deadlines_date ON cc_legal_deadlines(deadline_date);

-- Disputes: active disputes with correspondence tracking
CREATE TABLE cc_disputes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    counterparty    TEXT NOT NULL,
    dispute_type    TEXT NOT NULL,
    amount_claimed  NUMERIC(12,2),
    amount_at_stake NUMERIC(12,2),
    status          TEXT DEFAULT 'open',
    priority        INTEGER DEFAULT 5,
    description     TEXT,
    next_action     TEXT,
    next_action_date DATE,
    resolution_target TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Dispute correspondence log
CREATE TABLE cc_dispute_correspondence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id      UUID REFERENCES cc_disputes(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL,
    channel         TEXT NOT NULL,
    subject         TEXT,
    content         TEXT,
    attachments     JSONB DEFAULT '[]',
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_cc_dispute_corr_dispute ON cc_dispute_correspondence(dispute_id);

-- ── Triggers ─────────────────────────────────────────────────

CREATE TRIGGER cc_legal_deadlines_updated_at BEFORE UPDATE ON cc_legal_deadlines
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

CREATE TRIGGER cc_disputes_updated_at BEFORE UPDATE ON cc_disputes
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

COMMIT;
