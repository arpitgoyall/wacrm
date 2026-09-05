-- ============================================================
-- ASSIGNED DEAL VISIBILITY
-- ============================================================
-- Owners and admins can see every deal in their account. Other members
-- can see deals they created or deals assigned to their profile.
-- Pipelines and stages remain account-readable (see
-- 043_shared_pipeline_visibility.sql) so assigned deals can be displayed
-- on their pipeline board.

CREATE OR REPLACE FUNCTION can_view_deal(
  target_account_id UUID,
  target_creator_id UUID,
  target_assigned_profile_id UUID
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
        p.account_role IN ('owner', 'admin')
        OR p.user_id = target_creator_id
        OR p.id = target_assigned_profile_id
      )
  );
$$;

ALTER FUNCTION can_view_deal(UUID, UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_deal(UUID, UUID, UUID)
  TO authenticated, service_role;

DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals FOR SELECT
  USING (can_view_deal(account_id, user_id, assigned_to));

DROP POLICY IF EXISTS deals_insert ON deals;
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (can_view_deal(account_id, user_id, assigned_to));

DROP POLICY IF EXISTS deals_update ON deals;
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (can_view_deal(account_id, user_id, assigned_to))
  WITH CHECK (can_view_deal(account_id, user_id, assigned_to));

DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE
  USING (can_view_deal(account_id, user_id, assigned_to));