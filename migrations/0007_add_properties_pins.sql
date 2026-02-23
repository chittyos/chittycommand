-- ChittyCommand Properties & PINs
-- Migration: 0007_add_properties_pins
-- Date: 2026-02-23
-- Adds missing columns to cc_properties (property_name, annual_tax, mortgage_servicer,
-- mortgage_account), adds UNIQUE constraint on tax_pin, and inserts two properties
-- needed by Cook County tax scraper and Mr. Cooper scraper.

BEGIN;

-- ── Add missing columns ─────────────────────────────────────────
-- property_name: human-friendly label (cron.ts references this)
ALTER TABLE cc_properties ADD COLUMN IF NOT EXISTS property_name TEXT;

-- annual_tax: updated by Cook County tax scraper results
ALTER TABLE cc_properties ADD COLUMN IF NOT EXISTS annual_tax NUMERIC(12,2);

-- mortgage_servicer / mortgage_account: used by Mr. Cooper scraper
ALTER TABLE cc_properties ADD COLUMN IF NOT EXISTS mortgage_servicer TEXT;
ALTER TABLE cc_properties ADD COLUMN IF NOT EXISTS mortgage_account TEXT;

-- ── Unique constraint on tax_pin ────────────────────────────────
-- Enables ON CONFLICT (tax_pin) for upserts during scraper sync
ALTER TABLE cc_properties ADD CONSTRAINT uq_cc_properties_tax_pin UNIQUE (tax_pin);

-- ── Backfill property_name for existing rows ────────────────────
UPDATE cc_properties SET property_name = address || COALESCE(' ' || unit, '')
  WHERE property_name IS NULL;

-- ── Backfill tax_pin for existing Chicago properties ────────────
-- 541 W Addison St #3S — Cook County PIN
UPDATE cc_properties SET tax_pin = '14-21-307-032-1006'
  WHERE address = '541 W Addison St' AND unit = '#3S' AND tax_pin IS NULL;

-- 550 W Surf St #504 — Cook County PIN
UPDATE cc_properties SET tax_pin = '14-28-200-011-1042'
  WHERE address = '550 W Surf St' AND unit = '#504' AND tax_pin IS NULL;

-- ── Insert new properties ───────────────────────────────────────

-- Park Forest property — has Mr. Cooper mortgage
INSERT INTO cc_properties (property_name, address, tax_pin, annual_tax, mortgage_servicer, property_type, metadata)
VALUES (
  '211 E Surf St, Park Forest',
  '211 E Surf St, Park Forest, IL',
  '31-25-301-019-0000',
  NULL,
  'Mr. Cooper',
  'single_family',
  '{"municipality": "Park Forest", "county": "Cook", "state": "IL"}'::jsonb
)
ON CONFLICT (tax_pin) DO NOTHING;

-- Clarendon Hills property — no mortgage
INSERT INTO cc_properties (property_name, address, tax_pin, annual_tax, property_type, metadata)
VALUES (
  'Clarendon Hills',
  'Clarendon Hills, IL',
  '09-12-307-023-0000',
  NULL,
  'residential',
  '{"municipality": "Clarendon Hills", "county": "DuPage", "state": "IL"}'::jsonb
)
ON CONFLICT (tax_pin) DO NOTHING;

COMMIT;
