-- ============================================================
-- 051_ctwa_ad_registry.sql
--
-- Phase 1 of the CTWA ads-management work: a registry of the
-- Click-to-WhatsApp ads this account has actually received inbound
-- from, so the dashboard can report leads -> deals -> won -> revenue
-- per ad without a Meta Marketing API call.
--
--   - `ctwa_ads` has one row per (account, ad id). The ad id is Meta's
--     `referral.source_id` — the value that tells two audiences apart
--     when they run the same creative. The webhook upserts a row on
--     every CTWA inbound (see recordCtwaAd in the webhook route),
--     refreshing `last_seen_at` and filling in whatever creative
--     context Meta attached (`headline` / `body` / `source_url` /
--     `source_type`).
--   - `label` is a human name the user can edit from the Ads page
--     ("Launch 50% off - reel"). Everything else on the row is
--     Meta-supplied and refreshed from inbound traffic.
--
-- The per-ad funnel itself is derived at read time by joining this
-- registry against `contacts.ctwa_source_id` (leads) and
-- `deals.ctwa_source_id` (deals / won / revenue) — no denormalised
-- counters to keep in sync.
--
-- RLS: settings-class read for any member; only admin+ may rename.
-- Inserts/refreshes come from the webhook's service-role client, which
-- bypasses RLS, so there is no INSERT/DELETE policy.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ctwa_ads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Meta's `referral.source_id` (the ad id). Unique per account.
  source_id     text NOT NULL,
  -- User-editable friendly name. Defaults to NULL; the UI falls back
  -- to showing `source_id` until someone names the ad.
  label         text,
  -- Creative context Meta attaches to the referral, kept fresh from
  -- the most recent inbound that carried a non-null value.
  headline      text,
  body          text,
  source_url    text,
  source_type   text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source_id)
);

-- Every dashboard query filters by account_id.
CREATE INDEX IF NOT EXISTS ctwa_ads_account_id_idx ON ctwa_ads (account_id);

ALTER TABLE ctwa_ads ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the roster.
DROP POLICY IF EXISTS ctwa_ads_select ON ctwa_ads;
CREATE POLICY ctwa_ads_select ON ctwa_ads FOR SELECT
  USING (is_account_member(account_id));

-- UPDATE: admin+ only — the only user-editable field is `label`.
DROP POLICY IF EXISTS ctwa_ads_update ON ctwa_ads;
CREATE POLICY ctwa_ads_update ON ctwa_ads FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Backfill from contacts already carrying an ad id (migration 050
-- started persisting `contacts.ctwa_source_id`). first/last seen are
-- approximated from the contact rows; the webhook refreshes them and
-- the creative fields on the next inbound from each ad.
-- ------------------------------------------------------------
INSERT INTO ctwa_ads (account_id, source_id, first_seen_at, last_seen_at)
SELECT account_id, ctwa_source_id, MIN(created_at), MAX(created_at)
FROM contacts
WHERE ctwa_source_id IS NOT NULL
GROUP BY account_id, ctwa_source_id
ON CONFLICT (account_id, source_id) DO NOTHING;
