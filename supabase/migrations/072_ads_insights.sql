-- Shared reporting targets; attribution history already lives in ctwa_click_events (052).
CREATE TABLE IF NOT EXISTS ad_reporting_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  max_cpl numeric CHECK (max_cpl > 0),
  min_roas numeric CHECK (min_roas > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ad_reporting_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_reporting_settings_select ON ad_reporting_settings;
CREATE POLICY ad_reporting_settings_select ON ad_reporting_settings FOR SELECT
  USING (is_account_member(account_id));
-- Only the authenticated, admin-gated route writes via service role.
CREATE INDEX IF NOT EXISTS ctwa_click_events_history_idx
  ON ctwa_click_events(account_id, contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS ctwa_ad_insights_period_idx
  ON ctwa_ad_insights(account_id, date);
