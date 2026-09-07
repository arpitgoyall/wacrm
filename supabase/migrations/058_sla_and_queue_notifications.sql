-- ============================================================
-- 058_sla_and_queue_notifications.sql
--
-- Backs two notification types added in migration 057:
--
--   * new_conversation — a fresh conversation with no assignee. The
--     webhook writes one notification row per owner/admin. No schema
--     needed beyond 057; this migration only adds the SLA support.
--
--   * sla_breach — an assigned conversation whose last message is an
--     unanswered customer message older than the account's threshold.
--     Swept by /api/automations/cron.
--
--       accounts.sla_response_minutes   NULL / 0 → SLA alerts off.
--       conversations.sla_notified_at   when we last raised a breach
--                                       for the current unanswered run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sla_response_minutes INT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sla_notified_at TIMESTAMPTZ;

-- The sweep scans open, assigned conversations account by account.
CREATE INDEX IF NOT EXISTS idx_conversations_sla_scan
  ON conversations (account_id)
  WHERE status <> 'closed' AND assigned_agent_id IS NOT NULL;
