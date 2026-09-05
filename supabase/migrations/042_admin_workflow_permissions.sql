-- ============================================================
-- ADMIN-ONLY WORKFLOW AND CAMPAIGN CONFIGURATION
-- ============================================================
-- Owners and admins manage flows, automations, broadcasts, and their
-- child configuration. Agents and viewers retain read access only.

DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS automations_insert ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_update ON automations;
CREATE POLICY automations_update ON automations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_delete ON automations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS flows_insert ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_update ON flows;
CREATE POLICY flows_update ON flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_delete ON flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM broadcasts b
      WHERE b.id = broadcast_recipients.broadcast_id
        AND is_account_member(b.account_id, 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broadcasts b
      WHERE b.id = broadcast_recipients.broadcast_id
        AND is_account_member(b.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = automation_steps.automation_id
        AND is_account_member(a.account_id, 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = automation_steps.automation_id
        AND is_account_member(a.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM flows f
      WHERE f.id = flow_nodes.flow_id
        AND is_account_member(f.account_id, 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM flows f
      WHERE f.id = flow_nodes.flow_id
        AND is_account_member(f.account_id, 'admin')
    )
  );