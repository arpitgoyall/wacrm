-- ============================================================
-- 059_templates_team_wide_access.sql
--
-- Reclassifies message_templates from "settings-class" (admin+ write)
-- to "operational data" (agent+ write) — same tier as contacts /
-- conversations (migration 017). SELECT was already open to every
-- account member; only create/edit/delete were admin-gated.
--
-- Requested by the account owner: any team member (owner/admin/agent)
-- should be able to create and manage the shared template library,
-- not just admins. Viewers stay read-only, matching every other
-- operational table.
--
-- Idempotent — policies are dropped before recreate.
-- ============================================================

DROP POLICY IF EXISTS message_templates_insert ON message_templates;
CREATE POLICY message_templates_insert ON message_templates
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS message_templates_update ON message_templates;
CREATE POLICY message_templates_update ON message_templates
  FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS message_templates_delete ON message_templates;
CREATE POLICY message_templates_delete ON message_templates
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- message_templates_select is unchanged — every member (viewer+)
-- could already see every template in the account.
