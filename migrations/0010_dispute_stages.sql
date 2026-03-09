-- Add explicit lifecycle stage for disputes.
ALTER TABLE cc_disputes
  ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'filed';

-- Backfill existing rows.
UPDATE cc_disputes
SET stage = CASE
  WHEN status IN ('resolved', 'dismissed') THEN 'resolved'
  ELSE 'filed'
END
WHERE stage IS NULL;

ALTER TABLE cc_disputes
  ALTER COLUMN stage SET DEFAULT 'filed';

ALTER TABLE cc_disputes
  ALTER COLUMN stage SET NOT NULL;

