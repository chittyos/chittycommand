-- ChittyCommand Property Data Corrections
-- Migration: 0014_fix_properties
-- Date: 2026-03-24
-- Fixes wrong PINs, wrong addresses, and wrong properties from 0004/0007.
-- Authoritative source: project_entity_property_structure.md

BEGIN;

-- ── Fix PINs for existing properties ──────────────────────────

-- Addison: wrong PIN 14-21-307-032-1006 → correct 14-21-111-008-1006
UPDATE cc_properties SET tax_pin = '14-21-111-008-1006'
  WHERE address = '541 W Addison St' AND unit = '#3S';

-- Surf 504: wrong PIN 14-28-200-011-1042 → correct 14-28-122-017-1091
-- Also fix address: 550 → 559 W Surf St per deed
UPDATE cc_properties
  SET tax_pin = '14-28-122-017-1091',
      address = '559 W Surf St',
      unit = '#C504',
      property_name = '559 W Surf St #C504',
      hoa_payee = 'Commodore/Greenbrier Landmark Condo Association',
      metadata = metadata || '{"pin": "14-28-122-017-1091", "condo_declaration": "26911238"}'::jsonb
  WHERE address = '550 W Surf St' AND unit = '#504';

-- Backfill Addison metadata
UPDATE cc_properties
  SET metadata = metadata || '{"pin": "14-21-111-008-1006", "condo_declaration": "25024798", "condo_association": "Addition Lake Shore West Condominium"}'::jsonb
  WHERE address = '541 W Addison St' AND unit = '#3S';

-- ── Remove wrong properties from 0007 ────────────────────────

-- "211 E Surf St, Park Forest" was wrong — Surf 211 is actually 550 W Surf St #C211
DELETE FROM cc_properties WHERE tax_pin = '31-25-301-019-0000';

-- "Clarendon Hills" was wrong — should be 4343 N Clarendon Ave #1610
DELETE FROM cc_properties WHERE tax_pin = '09-12-307-023-0000';

-- ── Insert correct properties ─────────────────────────────────

-- Surf 211: 550 W Surf St #C211 (Commodore/Greenbriar Landmark)
INSERT INTO cc_properties (property_name, address, unit, tax_pin, property_type, hoa_payee, metadata)
VALUES (
  'Surf 211',
  '550 W Surf St',
  '#C211',
  '14-28-122-017-1180',
  'condo',
  'Commodore/Greenbriar Landmark Condo Association',
  '{"purchase_price": 100000, "purchase_date": "2022-07-01", "pin": "14-28-122-017-1180", "condo_declaration": "26911238", "owner_entity": "ARIBIA LLC - CITY STUDIO"}'::jsonb
)
ON CONFLICT (tax_pin) DO NOTHING;

-- Clarendon: 4343 N Clarendon Ave #1610
INSERT INTO cc_properties (property_name, address, unit, tax_pin, property_type, metadata)
VALUES (
  'Clarendon',
  '4343 N Clarendon Ave',
  '#1610',
  '14-16-300-032-1238',
  'condo',
  '{"pin": "14-16-300-032-1238", "owner_entity": "ARIBIA LLC - APT ARLENE"}'::jsonb
)
ON CONFLICT (tax_pin) DO NOTHING;

-- Medellín: International property held by ARIBIA LLC
INSERT INTO cc_properties (property_name, address, unit, property_type, metadata)
VALUES (
  'Medellín',
  'Urbanización Plaza De Colores, Carrera 76, Medellín, Colombia',
  'Apt 53 (215 Int. 1112)',
  'international',
  '{"country": "Colombia", "city": "Medellín", "apartment": "215 Int. 1112", "parking": "215 Int. 0226", "owner_entity": "ARIBIA LLC"}'::jsonb
);

-- ── Fix mortgage account metadata ─────────────────────────────

-- Update the Surf mortgage account to reflect correct address
UPDATE cc_accounts
  SET metadata = '{"property": "559 W Surf St #C504"}'::jsonb
  WHERE source = 'mr_cooper' AND account_name = '550 W Surf Mortgage';

-- ── Fix obligation metadata ───────────────────────────────────

UPDATE cc_obligations
  SET metadata = metadata || '{"pin": "14-21-111-008-1006"}'::jsonb
  WHERE category = 'mortgage' AND payee ILIKE '%Addison%';

UPDATE cc_obligations
  SET metadata = '{"property": "559 W Surf St #C504", "pin": "14-28-122-017-1091"}'::jsonb
  WHERE category = 'mortgage' AND payee ILIKE '%Surf%';

UPDATE cc_obligations
  SET metadata = metadata || '{"pin": "14-21-111-008-1006"}'::jsonb
  WHERE category = 'hoa' AND payee ILIKE '%Addison%';

UPDATE cc_obligations
  SET metadata = metadata || '{"property": "559 W Surf St #C504", "pin": "14-28-122-017-1091"}'::jsonb
  WHERE category = 'hoa' AND payee ILIKE '%Commodore%';

UPDATE cc_obligations
  SET metadata = metadata || '{"pin": "14-21-111-008-1006"}'::jsonb
  WHERE category = 'property_tax' AND payee ILIKE '%Addison%';

UPDATE cc_obligations
  SET metadata = '{"property": "559 W Surf St #C504", "pin": "14-28-122-017-1091", "installments": "June + September"}'::jsonb
  WHERE category = 'property_tax' AND payee ILIKE '%Surf%';

COMMIT;
