-- ============================================================
-- 066_deal_ctwa_attribution_snapshot.sql
--
-- Every deal must retain the CTWA attribution that belonged to its contact
-- when the deal was created. Keeping the snapshot on the deal prevents a
-- later click on another ad from rewriting historical campaign reporting.
--
-- The BEFORE INSERT trigger covers every writer: inbox, pipeline form,
-- automations, API clients, imports, and future code paths. Explicit values
-- supplied by a trusted importer are preserved; only NULL fields are filled.
--
-- Existing NULLs are backfilled conservatively from the most recent recorded
-- click at or before deal creation. We intentionally do not use the contact's
-- current last-touch fields for historical rows, because that could attribute
-- an old deal to an ad clicked after the deal was created.
-- ============================================================

CREATE OR REPLACE FUNCTION snapshot_deal_ctwa_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctwa_clid TEXT;
  v_ctwa_source_id TEXT;
BEGIN
  IF NEW.ctwa_clid IS NOT NULL AND NEW.ctwa_source_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.ctwa_clid, c.ctwa_source_id
    INTO v_ctwa_clid, v_ctwa_source_id
  FROM contacts c
  WHERE c.id = NEW.contact_id
    AND c.account_id = NEW.account_id;

  NEW.ctwa_clid := COALESCE(NEW.ctwa_clid, v_ctwa_clid);
  NEW.ctwa_source_id := COALESCE(NEW.ctwa_source_id, v_ctwa_source_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_snapshot_deal_ctwa_attribution ON deals;
CREATE TRIGGER trg_snapshot_deal_ctwa_attribution
  BEFORE INSERT ON deals
  FOR EACH ROW
  EXECUTE FUNCTION snapshot_deal_ctwa_attribution();

-- Recover only historically supportable attribution. DISTINCT ON selects the
-- last click known at the moment the deal was created.
WITH historical_attribution AS (
  SELECT DISTINCT ON (d.id)
    d.id AS deal_id,
    e.clid,
    e.ad_id
  FROM deals d
  JOIN ctwa_click_events e
    ON e.account_id = d.account_id
   AND e.contact_id = d.contact_id
   AND e.occurred_at <= d.created_at
  WHERE (d.ctwa_clid IS NULL OR d.ctwa_source_id IS NULL)
    AND (e.clid IS NOT NULL OR e.ad_id IS NOT NULL)
  ORDER BY d.id, e.occurred_at DESC, e.created_at DESC, e.id DESC
)
UPDATE deals d
SET
  ctwa_clid = COALESCE(d.ctwa_clid, h.clid),
  ctwa_source_id = COALESCE(d.ctwa_source_id, h.ad_id)
FROM historical_attribution h
WHERE d.id = h.deal_id
  AND (
    (d.ctwa_clid IS NULL AND h.clid IS NOT NULL)
    OR (d.ctwa_source_id IS NULL AND h.ad_id IS NOT NULL)
  );
