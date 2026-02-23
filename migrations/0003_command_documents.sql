-- ChittyCommand Documents, Recommendations & Sync Schema
-- Migration: 0003_command_documents
-- Date: 2026-02-09

BEGIN;

-- Documents: uploaded PDFs, parsed emails, scraped bills
CREATE TABLE cc_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type        TEXT NOT NULL,
    source          TEXT NOT NULL,
    filename        TEXT,
    r2_key          TEXT,
    content_text    TEXT,
    parsed_data     JSONB,
    linked_obligation_id UUID REFERENCES cc_obligations(id),
    linked_account_id    UUID REFERENCES cc_accounts(id),
    linked_dispute_id    UUID REFERENCES cc_disputes(id),
    processing_status TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- AI triage recommendations
CREATE TABLE cc_recommendations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obligation_id   UUID REFERENCES cc_obligations(id),
    dispute_id      UUID REFERENCES cc_disputes(id),
    rec_type        TEXT NOT NULL,
    priority        INTEGER NOT NULL,
    title           TEXT NOT NULL,
    reasoning       TEXT NOT NULL,
    estimated_savings NUMERIC(10,2),
    action_type     TEXT,
    action_payload  JSONB,
    action_url      TEXT,
    status          TEXT DEFAULT 'active',
    expires_at      TIMESTAMPTZ,
    model_version   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    acted_on_at     TIMESTAMPTZ
);

CREATE INDEX idx_cc_recommendations_priority ON cc_recommendations(priority);
CREATE INDEX idx_cc_recommendations_status ON cc_recommendations(status);

-- Action execution audit log
CREATE TABLE cc_actions_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type     TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       UUID,
    description     TEXT NOT NULL,
    request_payload JSONB,
    response_payload JSONB,
    status          TEXT NOT NULL,
    error_message   TEXT,
    executed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_actions_log_date ON cc_actions_log(executed_at DESC);

-- Cash flow projections
CREATE TABLE cc_cashflow_projections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    projection_date DATE NOT NULL,
    projected_inflow  NUMERIC(12,2) DEFAULT 0,
    projected_outflow NUMERIC(12,2) DEFAULT 0,
    projected_balance NUMERIC(12,2) DEFAULT 0,
    obligations     JSONB,
    confidence      NUMERIC(3,2),
    generated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_cashflow_date ON cc_cashflow_projections(projection_date);

-- Sync log: ingestion health tracking
CREATE TABLE cc_sync_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,
    sync_type       TEXT NOT NULL,
    status          TEXT NOT NULL,
    records_synced  INTEGER DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

COMMIT;
