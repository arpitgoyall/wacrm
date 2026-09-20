-- Record why a lead/deal was lost. Existing lost deals are left intact,
-- while all future status changes to lost must include a reason.
ALTER TABLE deals
  ADD COLUMN lost_reason TEXT;

ALTER TABLE deals
  ADD CONSTRAINT deals_lost_reason_required
  CHECK (
    status <> 'lost'
    OR NULLIF(BTRIM(lost_reason), '') IS NOT NULL
  ) NOT VALID;

COMMENT ON COLUMN deals.lost_reason IS
  'Required explanation when a deal is marked lost; cleared when reopened or won.';
