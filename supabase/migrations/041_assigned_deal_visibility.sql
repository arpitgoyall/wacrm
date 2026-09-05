-- ============================================================
-- ASSIGNED DEAL VISIBILITY
-- ============================================================
-- Owners can see every deal in their account. Other members can see
-- deals they created or deals assigned to their profile.
-- Pipelines and stages remain account-readable so assigned deals can
-- be displayed on their pipeline board.

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
        p.account_role = 'owner'
        OR p.user_id = target_creator_id
        OR p.id = target_assigned_profile_id
      )
  );
$$;

ALTER FUNCTION can_view_deal(UUID, UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_deal(UUID, UUID, UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION can_view_pipeline(
  target_pipeline_id UUID,
  target_account_id UUID,
  target_creator_id UUID
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
        OR p.user_id = target_creator_id
        OR EXISTS (
          SELECT 1
          FROM deals d
          WHERE d.pipeline_id = target_pipeline_id
            AND can_view_deal(d.account_id, d.user_id, d.assigned_to)
        )
      )
  );
$$;

ALTER FUNCTION can_view_pipeline(UUID, UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_pipeline(UUID, UUID, UUID)
  TO authenticated, service_role;

DROP POLICY IF EXISTS pipelines_select ON pipelines;
CREATE POLICY pipelines_select ON pipelines FOR SELECT
  USING (can_view_pipeline(id, account_id, user_id));

DROP POLICY IF EXISTS pipeline_stages_select ON pipeline_stages;
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (
    SELECT 1
    FROM pipelines p
    WHERE p.id = pipeline_stages.pipeline_id
      AND can_view_pipeline(p.id, p.account_id, p.user_id)
  )
);

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