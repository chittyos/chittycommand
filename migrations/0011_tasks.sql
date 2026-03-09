-- 0011_tasks.sql — Backend-driven task system for Notion agent integration
CREATE TABLE IF NOT EXISTS cc_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE NOT NULL,
  notion_page_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'notion',
  priority INTEGER DEFAULT 5,
  backend_status TEXT NOT NULL DEFAULT 'queued',
  assigned_to TEXT,
  due_date DATE,
  verification_type TEXT NOT NULL DEFAULT 'soft',
  verification_artifact TEXT,
  verification_notes TEXT,
  verified_at TIMESTAMPTZ,
  spawned_recommendation_id UUID REFERENCES cc_recommendations(id),
  ledger_record_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cc_tasks_status ON cc_tasks(backend_status);
CREATE INDEX idx_cc_tasks_external_id ON cc_tasks(external_id);
CREATE INDEX idx_cc_tasks_notion_page_id ON cc_tasks(notion_page_id);
CREATE INDEX idx_cc_tasks_due_date ON cc_tasks(due_date);
CREATE INDEX idx_cc_tasks_priority ON cc_tasks(priority);
CREATE INDEX idx_cc_tasks_type ON cc_tasks(task_type);
