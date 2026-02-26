-- Migration 0008: Swipe Queue + Payment Planner
-- Adds decision feedback tracking, revenue source discovery, and payment plan tables
-- Plus escalation tracking on obligations and planner-aware fields on recommendations

-- ── New Tables ─────────────────────────────────────────────────

-- Decision feedback: tracks every swipe/decision for learning
CREATE TABLE IF NOT EXISTS cc_decision_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID REFERENCES cc_recommendations(id),
  obligation_id UUID REFERENCES cc_obligations(id),
  decision TEXT NOT NULL,
  original_action TEXT,
  modified_action TEXT,
  confidence_at_decision NUMERIC(3,2),
  outcome_status TEXT,
  outcome_recorded_at TIMESTAMPTZ,
  session_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_decision_feedback_rec ON cc_decision_feedback(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_cc_decision_feedback_ob ON cc_decision_feedback(obligation_id);
CREATE INDEX IF NOT EXISTS idx_cc_decision_feedback_created ON cc_decision_feedback(created_at);

-- Revenue sources: real verified income streams
CREATE TABLE IF NOT EXISTS cc_revenue_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_id TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  recurrence TEXT,
  recurrence_day INTEGER,
  next_expected_date DATE,
  confidence NUMERIC(3,2) DEFAULT 0.50,
  verified_by TEXT,
  contract_ref TEXT,
  account_id UUID REFERENCES cc_accounts(id),
  status TEXT DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_revenue_sources_next ON cc_revenue_sources(next_expected_date);
CREATE INDEX IF NOT EXISTS idx_cc_revenue_sources_status ON cc_revenue_sources(status);

-- Payment plans: generated scenario plans
CREATE TABLE IF NOT EXISTS cc_payment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_type TEXT NOT NULL,
  horizon_days INTEGER DEFAULT 90,
  starting_balance NUMERIC(12,2),
  ending_balance NUMERIC(12,2),
  lowest_balance NUMERIC(12,2),
  lowest_balance_date DATE,
  total_inflows NUMERIC(12,2),
  total_outflows NUMERIC(12,2),
  total_late_fees_avoided NUMERIC(12,2) DEFAULT 0,
  total_late_fees_risked NUMERIC(12,2) DEFAULT 0,
  schedule JSONB NOT NULL,
  warnings JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_payment_plans_status ON cc_payment_plans(status);

-- ── Column Additions ──────────────────────────────────────────

-- Obligations: escalation tracking
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS escalation_type TEXT;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS escalation_threshold_days INTEGER;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS escalation_amount NUMERIC(8,2);
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS credit_impact_score INTEGER;
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS preferred_account_id UUID REFERENCES cc_accounts(id);

-- Recommendations: planner-aware fields
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2);
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS suggested_account_id UUID REFERENCES cc_accounts(id);
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS suggested_amount NUMERIC(12,2);
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS payment_sequence INTEGER;
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS escalation_risk TEXT;
ALTER TABLE cc_recommendations ADD COLUMN IF NOT EXISTS scenario_impact JSONB;
