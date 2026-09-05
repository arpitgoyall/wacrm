-- ============================================================
-- ASSIGNED CONTACT VISIBILITY
-- ============================================================
-- Owners/admins/viewers see all contacts (viewers are read-only
-- oversight, same as before this migration). Agents see only contacts
-- assigned to their auth user. Agents may create and update assigned
-- contacts, but only owners/admins may delete contacts.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_assigned_agent
  ON contacts(assigned_agent_id);

DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id = contacts.account_id
        AND (
          p.account_role IN ('owner', 'admin', 'viewer')
          OR contacts.assigned_agent_id = auth.uid()
          OR EXISTS (
            SELECT 1
            FROM conversations c
            WHERE c.contact_id = contacts.id
              AND c.assigned_agent_id = auth.uid()
          )
        )
    )
  );

DROP POLICY IF EXISTS contacts_insert ON contacts;
CREATE POLICY contacts_insert ON contacts FOR INSERT
  WITH CHECK (
    (
      assigned_agent_id = auth.uid()
      AND is_account_member(account_id, 'agent')
    )
    OR is_account_member(account_id, 'admin')
  );

DROP POLICY IF EXISTS contacts_update ON contacts;
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (
    (
      assigned_agent_id = auth.uid()
      AND is_account_member(account_id, 'agent')
    )
    OR is_account_member(account_id, 'admin')
  )
  WITH CHECK (
    (
      assigned_agent_id = auth.uid()
      AND is_account_member(account_id, 'agent')
    )
    OR is_account_member(account_id, 'admin')
  );

DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'admin'));