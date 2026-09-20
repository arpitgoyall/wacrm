-- ============================================================
-- AGENT DEAL SELF-ASSIGNMENT
-- ============================================================
-- Keep assignment consistent regardless of which UI or API path an
-- authenticated agent uses. Owners and server-side automation calls
-- are unaffected (service-role requests have no auth.uid()).

CREATE OR REPLACE FUNCTION enforce_agent_deal_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  agent_profile_id UUID;
BEGIN
  SELECT p.id
  INTO agent_profile_id
  FROM profiles p
  WHERE p.user_id = auth.uid()
    AND p.account_id = NEW.account_id
    AND p.account_role = 'agent'
  LIMIT 1;

  IF agent_profile_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.assigned_to := agent_profile_id;
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    NEW.assigned_to := OLD.assigned_to;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION enforce_agent_deal_assignment() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_enforce_agent_deal_assignment ON deals;
CREATE TRIGGER trg_enforce_agent_deal_assignment
  BEFORE INSERT OR UPDATE OF assigned_to ON deals
  FOR EACH ROW
  EXECUTE FUNCTION enforce_agent_deal_assignment();
