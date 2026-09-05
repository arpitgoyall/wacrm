-- ============================================================
-- SHARED PIPELINE VISIBILITY
-- ============================================================
-- Pipeline definitions and stages are shared account structure. Deal
-- visibility remains restricted by 041_assigned_deal_visibility.

DROP POLICY IF EXISTS pipelines_select ON pipelines;
CREATE POLICY pipelines_select ON pipelines FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS pipeline_stages_select ON pipeline_stages;
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (
    SELECT 1
    FROM pipelines p
    WHERE p.id = pipeline_stages.pipeline_id
      AND is_account_member(p.account_id)
  )
);