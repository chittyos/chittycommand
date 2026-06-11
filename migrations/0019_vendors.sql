-- 0019_vendors.sql — Vendor spend control: recurring org vendors + autopay/budget risk
-- Migration: 0019_vendors
-- Date: 2026-06-11
-- Creates: cc_vendors (recurring vendor spend tracking for budget/autopay-bounce control)
--
-- Additive + idempotent. Applied after the journaled drizzle schema (cc_accounts
-- must already exist for the optional account_id FK). Mirrors the 0017/0018
-- hand-rolled additive pattern and is registered in tests/setup/global-setup.ts.
--
-- Prod apply (same path as 0006–0018; the drizzle journal ends at
-- 0005_sour_dreadnoughts, so `npm run db:migrate` does NOT apply this file):
--   psql "$DATABASE_URL" < migrations/0019_vendors.sql
-- The shared cc_update_timestamp() trigger function is (re)defined here so this
-- migration is self-sufficient on branches where only the journaled drizzle
-- history (which does not manage triggers) has been applied.

BEGIN;

-- ── Shared trigger function (idempotent; defined in 0001_command_core too) ──
CREATE OR REPLACE FUNCTION cc_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Vendors ─────────────────────────────────────────────────────
-- One row per recurring spend relationship (GitHub, Cloudflare, Anthropic,
-- OpenAI, Neon, 1Password, …). payment_status='failed'|'limited' is the
-- autopay-bounce signal that surprised us with the GitHub Actions billing block.
CREATE TABLE IF NOT EXISTS cc_vendors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name     TEXT NOT NULL UNIQUE,
    category        TEXT DEFAULT 'other',     -- infra | ai_inference | dev_tooling | data | communication | subscription | other
    billing_cycle   TEXT,                     -- monthly | quarterly | annual | usage | one_time
    expected_amount NUMERIC(12,2),            -- expected recurring charge
    currency        TEXT DEFAULT 'USD',
    next_bill_date  DATE,
    auto_pay        BOOLEAN DEFAULT false,
    payment_status  TEXT DEFAULT 'unknown',   -- active | failed | limited | unknown
    payment_method  TEXT,                     -- descriptor, e.g. 'amex-1234', 'mercury-ach'
    spending_limit  NUMERIC(12,2),            -- provider hard cap (e.g. GH Actions spending limit)
    mtd_spend       NUMERIC(12,2) DEFAULT 0,  -- month-to-date spend
    budget_limit    NUMERIC(12,2),            -- our internal monthly budget
    status          TEXT DEFAULT 'active',    -- active | paused | cancelled | zombie
    owner           TEXT,                     -- who owns the vendor relationship
    account_id      UUID REFERENCES cc_accounts(id),  -- paying account (optional)
    risk_score      INTEGER,                  -- last computed spend-risk (0-100)
    last_charge_at  TIMESTAMPTZ,
    last_synced_at  TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_vendors_category ON cc_vendors(category);
CREATE INDEX IF NOT EXISTS idx_cc_vendors_status ON cc_vendors(status);
CREATE INDEX IF NOT EXISTS idx_cc_vendors_next_bill ON cc_vendors(next_bill_date);
CREATE INDEX IF NOT EXISTS idx_cc_vendors_risk ON cc_vendors(risk_score DESC NULLS LAST);

DROP TRIGGER IF EXISTS cc_vendors_updated_at ON cc_vendors;
CREATE TRIGGER cc_vendors_updated_at BEFORE UPDATE ON cc_vendors
  FOR EACH ROW EXECUTE FUNCTION cc_update_timestamp();

COMMIT;
