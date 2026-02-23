-- ChittyCommand Core Schema
-- Migration: 0001_command_core
-- Date: 2026-02-09
-- Creates: cc_accounts, cc_obligations, cc_transactions, cc_properties + timestamp trigger

BEGIN;

-- ── Shared trigger function ─────────────────────────────────────
CREATE OR REPLACE FUNCTION cc_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Accounts ────────────────────────────────────────────────────
CREATE TABLE cc_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,
    source_id       TEXT,
    account_name    TEXT NOT NULL,
    account_type    TEXT NOT NULL,
    institution     TEXT NOT NULL,
    current_balance NUMERIC(12,2),
    credit_limit    NUMERIC(12,2),
    interest_rate   NUMERIC(5,2),
    last_synced_at  TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_accounts_source ON cc_accounts(source, source_id);
CREATE INDEX idx_cc_accounts_type ON cc_accounts(account_type);

-- ── Obligations ─────────────────────────────────────────────────
CREATE TABLE cc_obligations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID REFERENCES cc_accounts(id),
    category        TEXT NOT NULL,
    subcategory     TEXT,
    payee           TEXT NOT NULL,
    amount_due      NUMERIC(12,2),
    amount_minimum  NUMERIC(12,2),
    due_date        DATE NOT NULL,
    recurrence      TEXT,
    recurrence_day  INTEGER,
    status          TEXT DEFAULT 'pending',
    auto_pay        BOOLEAN DEFAULT false,
    negotiable      BOOLEAN DEFAULT false,
    late_fee        NUMERIC(10,2),
    grace_period_days INTEGER DEFAULT 0,
    urgency_score   INTEGER,
    action_type     TEXT,
    action_payload  JSONB,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_obligations_due ON cc_obligations(due_date);
CREATE INDEX idx_cc_obligations_status ON cc_obligations(status);
CREATE INDEX idx_cc_obligations_urgency ON cc_obligations(urgency_score DESC NULLS LAST);

-- ── Transactions ────────────────────────────────────────────────
CREATE TABLE cc_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID REFERENCES cc_accounts(id),
    source          TEXT NOT NULL,
    source_id       TEXT,
    amount          NUMERIC(12,2) NOT NULL,
    direction       TEXT NOT NULL,
    description     TEXT NOT NULL,
    category        TEXT,
    counterparty    TEXT,
    tx_date         DATE NOT NULL,
    obligation_id   UUID REFERENCES cc_obligations(id),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_transactions_account ON cc_transactions(account_id, tx_date DESC);
CREATE INDEX idx_cc_transactions_source ON cc_transactions(source, source_id);
CREATE INDEX idx_cc_transactions_date ON cc_transactions(tx_date DESC);
CREATE INDEX idx_cc_transactions_obligation ON cc_transactions(obligation_id);

-- ── Properties ──────────────────────────────────────────────────
CREATE TABLE cc_properties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address         TEXT NOT NULL,
    unit            TEXT,
    property_type   TEXT NOT NULL,
    mortgage_account_id UUID REFERENCES cc_accounts(id),
    hoa_payee       TEXT,
    tax_pin         TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Triggers ────────────────────────────────────────────────────

CREATE TRIGGER cc_accounts_updated_at BEFORE UPDATE ON cc_accounts
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

CREATE TRIGGER cc_obligations_updated_at BEFORE UPDATE ON cc_obligations
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

CREATE TRIGGER cc_properties_updated_at BEFORE UPDATE ON cc_properties
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

COMMIT;
