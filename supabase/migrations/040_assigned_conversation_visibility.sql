-- ============================================================
-- ASSIGNED CONVERSATION VISIBILITY
-- ============================================================
-- Owners can see every conversation in their account. Other members
-- can see only conversations assigned to their own user id.

CREATE OR REPLACE FUNCTION can_view_conversation(
  target_account_id UUID,
  target_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (
        p.account_role = 'owner'
        OR p.user_id = target_assigned_agent_id
      )
  );
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID)
  TO authenticated, service_role;

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_view_conversation(account_id, assigned_agent_id));

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (can_view_conversation(account_id, assigned_agent_id))
  WITH CHECK (can_view_conversation(account_id, assigned_agent_id));

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1
    FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1
    FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1
    FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);