-- ============================================================
-- 053_meta_ads_sync.sql
--
-- Phase 2 of the CTWA ads work: pull ad structure + spend from the
-- Meta Marketing API so the Ads dashboard can show ROAS / CPL /
-- cost-per-deal and roll leads up by ad set / campaign.
--
--   1. `whatsapp_config` gains the ad-account connection:
--        - `ad_account_id`   — "act_<n>" (or the bare number)
--        - `ad_insights_token` — a System User token with `ads_read`,
--          encrypted at rest like `access_token` / `ctwa_capi_token`
--        - `ad_sync_enabled` — master switch for the sync job
--        - `ad_synced_at` / `ad_sync_error` — last run status
--
--   2. `ctwa_ads` (registry from migration 051) gains the Meta-side
--      structure, matched on `source_id = ad.id`:
--        - `campaign_id` / `adset_id` — for the rollup
--        - `meta_name`  — Meta's own ad name (distinct from the
--          user-editable `label`)
--        - `effective_status` — ACTIVE / PAUSED / …
--        - `meta_synced_at`
--
--   3. `meta_campaigns` / `meta_adsets` — name + status + budget for
--      the rollup labels.
--
--   4. `ctwa_ad_insights` — one row per (ad, day) with spend and the
--      messaging metrics, upserted from a rolling insights window.
--
-- The sync runs from `/api/automations/cron` (see
-- `syncMetaAds`), self-throttled per account so it hits the Marketing
-- API at most hourly regardless of how often the cron fires.
--
-- RLS: settings-class read for any member on the three new tables;
-- writes come from the cron's service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Ad-account connection on whatsapp_config ---------------------------

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS ad_account_id TEXT,
  ADD COLUMN IF NOT EXISTS ad_insights_token TEXT,
  ADD COLUMN IF NOT EXISTS ad_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ad_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ad_sync_error TEXT;

-- 2. Meta structure on the ad registry --------------------------------

ALTER TABLE ctwa_ads
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS adset_id TEXT,
  ADD COLUMN IF NOT EXISTS meta_name TEXT,
  ADD COLUMN IF NOT EXISTS effective_status TEXT,
  ADD COLUMN IF NOT EXISTS meta_synced_at TIMESTAMPTZ;

-- 3. Campaign / ad-set label tables ----------------------------------

CREATE TABLE IF NOT EXISTS meta_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id      text NOT NULL,
  name             text,
  objective        text,
  status           text,
  effective_status text,
  daily_budget     numeric,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS meta_campaigns_account_idx ON meta_campaigns (account_id);
ALTER TABLE meta_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_campaigns_select ON meta_campaigns;
CREATE POLICY meta_campaigns_select ON meta_campaigns FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS meta_adsets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  adset_id         text NOT NULL,
  campaign_id      text,
  name             text,
  status           text,
  effective_status text,
  daily_budget     numeric,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, adset_id)
);
CREATE INDEX IF NOT EXISTS meta_adsets_account_idx ON meta_adsets (account_id);
ALTER TABLE meta_adsets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_adsets_select ON meta_adsets;
CREATE POLICY meta_adsets_select ON meta_adsets FOR SELECT
  USING (is_account_member(account_id));

-- 4. Per-ad per-day insights --------------------------------------------

CREATE TABLE IF NOT EXISTS ctwa_ad_insights (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_id             text NOT NULL,
  date              date NOT NULL,
  spend             numeric NOT NULL DEFAULT 0,
  impressions       bigint NOT NULL DEFAULT 0,
  link_clicks       bigint NOT NULL DEFAULT 0,
  messaging_started bigint NOT NULL DEFAULT 0,
  currency          text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ad_id, date)
);
CREATE INDEX IF NOT EXISTS ctwa_ad_insights_account_ad_idx
  ON ctwa_ad_insights (account_id, ad_id);
ALTER TABLE ctwa_ad_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ctwa_ad_insights_select ON ctwa_ad_insights;
CREATE POLICY ctwa_ad_insights_select ON ctwa_ad_insights FOR SELECT
  USING (is_account_member(account_id));
