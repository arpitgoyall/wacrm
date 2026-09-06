-- ============================================================
-- 049_support_pipeline.sql
--
-- Mirrors the sales pipeline from migration 048: an optional pipeline
-- support-tagged agents see in the inbox instead of conversation
-- status. Unlike sales, support agents keep the "assign to" control —
-- only the status-vs-pipeline swap is symmetric here.
--
-- Unset (NULL) is the default and preserves today's behavior exactly:
-- support-tagged (and untagged) agents keep seeing Open/Pending/Closed.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS support_pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL;
