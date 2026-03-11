-- 0012_dispute_sync_indexes.sql
-- Indexes for dispute ↔ Notion ↔ TriageAgent sync lookups.

-- Unique constraint: one dispute per Notion page (prevents duplicates from concurrent sync runs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_disputes_notion_task_id_unique
  ON cc_disputes ((metadata->>'notion_task_id'))
  WHERE metadata->>'notion_task_id' IS NOT NULL;

-- Fast lookup: find tasks by dispute_id (loop guard)
CREATE INDEX IF NOT EXISTS idx_cc_tasks_dispute_id
  ON cc_tasks ((metadata->>'dispute_id'))
  WHERE metadata->>'dispute_id' IS NOT NULL;

-- Partial index for the reconciliation query (legal tasks not yet linked to disputes)
CREATE INDEX IF NOT EXISTS idx_cc_tasks_legal_unlinked
  ON cc_tasks (priority ASC, created_at ASC)
  WHERE task_type = 'legal'
    AND backend_status NOT IN ('done', 'verified')
    AND (metadata->>'dispute_id') IS NULL;
