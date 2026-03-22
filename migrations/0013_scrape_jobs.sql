-- 0013_scrape_jobs.sql — Scrape job orchestration + identity binding

-- Scrape job queue with retry, status tracking, and ChittyID binding
CREATE TABLE IF NOT EXISTS cc_scrape_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chitty_id VARCHAR(64),
  job_type VARCHAR(50) NOT NULL,
  target JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error_message TEXT,
  parent_job_id UUID REFERENCES cc_scrape_jobs(id),
  cron_source VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cc_scrape_jobs_status ON cc_scrape_jobs(status, scheduled_at);
CREATE INDEX idx_cc_scrape_jobs_type ON cc_scrape_jobs(job_type);
CREATE INDEX idx_cc_scrape_jobs_chitty ON cc_scrape_jobs(chitty_id);

-- Add chitty_id to existing tables for identity binding
ALTER TABLE cc_sync_log ADD COLUMN IF NOT EXISTS chitty_id VARCHAR(64);
ALTER TABLE cc_legal_deadlines ADD COLUMN IF NOT EXISTS chitty_id VARCHAR(64);
ALTER TABLE cc_properties ADD COLUMN IF NOT EXISTS chitty_id VARCHAR(64);
ALTER TABLE cc_documents ADD COLUMN IF NOT EXISTS chitty_id VARCHAR(64);
ALTER TABLE cc_obligations ADD COLUMN IF NOT EXISTS chitty_id VARCHAR(64);
