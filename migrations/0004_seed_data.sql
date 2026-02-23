-- ChittyCommand Seed Data
-- Migration: 0004_seed_data
-- Date: 2026-02-09
-- Real obligations, accounts, disputes, and legal deadlines

BEGIN;

-- ── Accounts ──────────────────────────────────────────────────

-- Banking
INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('mercury', 'ARIBIA LLC Operating', 'checking', 'Mercury', '{"entity": "ARIBIA LLC"}');

INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('mercury', 'IT CAN BE LLC Operating', 'checking', 'Mercury', '{"entity": "IT CAN BE LLC"}');

-- Mortgage
INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('mr_cooper', '541 W Addison Mortgage', 'mortgage', 'Mr. Cooper', '{"property": "541 W Addison St #3S"}');

INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('mr_cooper', '550 W Surf Mortgage', 'mortgage', 'Mr. Cooper', '{"property": "550 W Surf St"}');

-- Credit Cards
INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('citi', 'Citi Credit Card', 'credit_card', 'Citibank', '{}');

INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('home_depot', 'Home Depot Credit', 'store_credit', 'Home Depot', '{}');

INSERT INTO cc_accounts (source, account_name, account_type, institution, metadata)
VALUES ('lowes', 'Lowes Credit', 'store_credit', 'Lowes', '{}');

-- ── Properties ────────────────────────────────────────────────

INSERT INTO cc_properties (address, unit, property_type, hoa_payee, metadata)
VALUES ('541 W Addison St', '#3S', 'condo', 'HOA - 541 W Addison', '{"purchase_price": 202000, "purchase_date": "2019-11-22", "lender": "USAA"}');

INSERT INTO cc_properties (address, unit, property_type, hoa_payee, metadata)
VALUES ('550 W Surf St', '#504', 'condo', 'Commodore Green Briar Landmark Condo Association', '{"purchase_price": 237500, "purchase_date": "2022-04-26", "lender": "SoFi"}');

-- ── Obligations ───────────────────────────────────────────────
-- All due_date values represent the next upcoming payment date from 2026-02-09

-- Mortgage payments (due 1st of month)
INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status, metadata)
VALUES ('mortgage', 'Mr. Cooper - 541 W Addison', '2026-03-01', 'monthly', 1, 'pending', '{"property": "541 W Addison St #3S"}');

INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status, metadata)
VALUES ('mortgage', 'Mr. Cooper - 550 W Surf', '2026-03-01', 'monthly', 1, 'pending', '{"property": "550 W Surf St #504"}');

-- Utilities
INSERT INTO cc_obligations (category, subcategory, payee, due_date, recurrence, recurrence_day, status, negotiable)
VALUES ('utility', 'electric', 'ComEd', '2026-02-15', 'monthly', 15, 'pending', false);

INSERT INTO cc_obligations (category, subcategory, payee, due_date, recurrence, recurrence_day, status, negotiable)
VALUES ('utility', 'gas', 'Peoples Gas', '2026-02-20', 'monthly', 20, 'pending', false);

INSERT INTO cc_obligations (category, subcategory, payee, due_date, recurrence, recurrence_day, status, negotiable)
VALUES ('utility', 'internet', 'Xfinity', '2026-02-10', 'monthly', 10, 'pending', true);

-- HOA fees (due 1st of month)
INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status, metadata)
VALUES ('hoa', 'HOA - 541 W Addison', '2026-03-01', 'monthly', 1, 'pending', '{"property": "541 W Addison St #3S"}');

INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status, negotiable, metadata)
VALUES ('hoa', 'Commodore Green Briar Landmark Condo Association', '2026-03-01', 'monthly', 1, 'pending', false, '{"property": "550 W Surf St #504", "dispute_active": true}');

-- Property taxes (Cook County 1st installment due June 1)
INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('property_tax', 'Cook County Tax Collector - 541 W Addison', '2026-06-01', 'annual', 'pending', '{"property": "541 W Addison St #3S", "installments": "June + September"}');

INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('property_tax', 'Cook County Tax Collector - 550 W Surf', '2026-06-01', 'annual', 'pending', '{"property": "550 W Surf St #504", "installments": "June + September"}');

-- Credit card minimums
INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status)
VALUES ('credit_card', 'Citibank - Minimum Payment', '2026-02-25', 'monthly', 25, 'pending');

INSERT INTO cc_obligations (category, subcategory, payee, due_date, recurrence, recurrence_day, status)
VALUES ('credit_card', 'store_credit', 'Home Depot Credit - Minimum Payment', '2026-02-20', 'monthly', 20, 'pending');

INSERT INTO cc_obligations (category, subcategory, payee, due_date, recurrence, recurrence_day, status)
VALUES ('credit_card', 'store_credit', 'Lowes Credit - Minimum Payment', '2026-02-15', 'monthly', 15, 'pending');

-- IRS quarterly estimates
INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('federal_tax', 'IRS - Q1 2026 Estimated', '2026-04-15', 'quarterly', 'pending', '{"quarter": "Q1 2026"}');

INSERT INTO cc_obligations (category, payee, due_date, recurrence, status, metadata)
VALUES ('federal_tax', 'IRS - Q2 2026 Estimated', '2026-06-15', 'quarterly', 'pending', '{"quarter": "Q2 2026"}');

-- Personal loans (litigation, due 1st of month)
INSERT INTO cc_obligations (category, payee, due_date, recurrence, recurrence_day, status, metadata)
VALUES ('loan', 'Litigation Personal Loan', '2026-03-01', 'monthly', 1, 'pending', '{"type": "litigation_funding"}');

-- ── Disputes ──────────────────────────────────────────────────

INSERT INTO cc_disputes (title, counterparty, dispute_type, status, priority, description, next_action)
VALUES (
  'Xfinity Pricing & Credit Dispute',
  'Xfinity / Comcast',
  'billing',
  'open',
  2,
  'Dispute regarding pricing discrepancies and pending credits on account. Xfinity charged higher than agreed rate and has not applied promised credits.',
  'Follow up on credit application status, escalate if unresolved'
);

INSERT INTO cc_disputes (title, counterparty, dispute_type, status, priority, description, next_action)
VALUES (
  'Commodore Green Briar HOA Dispute',
  'Commodore Green Briar Landmark Condo Association',
  'hoa',
  'open',
  3,
  'Ongoing dispute with Commodore Green Briar Landmark Condo Association regarding assessments, maintenance obligations, or fee discrepancies at 550 W Surf St #504.',
  'Review HOA correspondence, prepare response'
);

INSERT INTO cc_disputes (title, counterparty, dispute_type, amount_claimed, amount_at_stake, status, priority, description, next_action)
VALUES (
  'Fox Rental $14K+ Reclaim',
  'Fox Rental',
  'financial',
  14000.00,
  14000.00,
  'open',
  1,
  'Reclaiming $14,000+ from Fox Rental dispute. Funds owed based on prior agreement or overcharge.',
  'Gather supporting documentation, file formal demand if not yet done'
);

-- ── Legal Deadlines ───────────────────────────────────────────

INSERT INTO cc_legal_deadlines (case_ref, case_system, deadline_type, title, deadline_date, status, urgency_score)
VALUES (
  'Arias v. Bianchi (2024D007847)',
  'cook_county',
  'court_date',
  'Next Court Hearing - Judge Robert W. Johnson',
  '2026-03-31 11:00:00-05',
  'upcoming',
  65
);

COMMIT;
