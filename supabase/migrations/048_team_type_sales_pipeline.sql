-- ============================================================
-- 048_team_type_sales_pipeline.sql
--
-- Tags an agent as 'sales' or 'support' (only meaningful for
-- account_role = 'agent' — owners/admins/viewers ignore it and
-- always see the normal inbox controls). Sales-tagged agents see
-- the account's chosen sales pipeline (stage picker) instead of
-- conversation status, and never see the "assign to" control.
--
-- Untagged (NULL) agents keep today's behavior — this is additive,
-- no backfill needed.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_type_enum') THEN
    CREATE TYPE team_type_enum AS ENUM ('sales', 'support');
  END IF;
END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS team_type team_type_enum;

-- One sales pipeline per account (admin-configured in Settings →
-- Deals & currency) — the pipeline every sales-tagged agent sees.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sales_pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL;

-- ============================================================
-- set_member_team_type(p_user_id, p_team_type)
--
-- Admin+ tags (or clears, via NULL) a teammate's team. Mirrors
-- set_member_role (migration 018): profiles_update RLS only allows
-- self-updates, so this SECURITY DEFINER function is the supervised
-- escape hatch. Restricted to agent-role targets — team type has no
-- meaning for owner/admin/viewer.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_team_type(
  p_user_id UUID,
  p_team_type team_type_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role <> 'agent' THEN
    RAISE EXCEPTION 'Team type only applies to the agent role'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET team_type = p_team_type
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_team_type(UUID, team_type_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_team_type(UUID, team_type_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_team_type(UUID, team_type_enum) TO authenticated;
