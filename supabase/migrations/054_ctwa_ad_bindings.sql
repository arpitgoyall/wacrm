-- ============================================================
-- 054_ctwa_ad_bindings.sql
--
-- Phase 3 of the CTWA ads work: bind a Click-to-WhatsApp ad (or a
-- whole campaign) to a Flow, so a lead from that ad is dropped
-- straight into the right conversation flow — without hand-wiring a
-- `variable` condition on `ctwa_source_id` inside a
-- `first_inbound_message` flow.
--
--   - `match_type = 'ad'`       → `match_value` is the ad id
--     (`referral.source_id`, the same value stored on
--     `ctwa_ads.source_id`).
--   - `match_type = 'campaign'` → `match_value` is `ctwa_ads.campaign_id`
--     (populated by the Marketing API sync, migration 053). The webhook
--     resolves the ad's campaign via `ctwa_ads` before matching.
--
-- The WhatsApp webhook resolves at most one binding per inbound ad
-- referral (ad-level beats campaign-level) and hands the flow id to the
-- Flows engine, which starts that flow instead of trigger-matching.
--
-- One binding per (account, match_type, match_value) — the UNIQUE
-- constraint — so the resolution is unambiguous. Automation targets are
-- a deliberate future extension; this table is flow-only for now.
--
-- RLS: settings-class read for any member; only admin+ may change a
-- binding (writes go through the service-role API route, which enforces
-- the role, so this is the guard for direct dashboard reads).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ctwa_ad_bindings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  match_type   text NOT NULL CHECK (match_type IN ('ad', 'campaign')),
  match_value  text NOT NULL,
  flow_id      uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, match_type, match_value)
);

-- Webhook lookup path: (account, type, value) among active bindings.
CREATE INDEX IF NOT EXISTS ctwa_ad_bindings_lookup_idx
  ON ctwa_ad_bindings (account_id, match_type, match_value)
  WHERE is_active;

ALTER TABLE ctwa_ad_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ctwa_ad_bindings_select ON ctwa_ad_bindings;
CREATE POLICY ctwa_ad_bindings_select ON ctwa_ad_bindings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ctwa_ad_bindings_insert ON ctwa_ad_bindings;
CREATE POLICY ctwa_ad_bindings_insert ON ctwa_ad_bindings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ctwa_ad_bindings_update ON ctwa_ad_bindings;
CREATE POLICY ctwa_ad_bindings_update ON ctwa_ad_bindings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ctwa_ad_bindings_delete ON ctwa_ad_bindings;
CREATE POLICY ctwa_ad_bindings_delete ON ctwa_ad_bindings FOR DELETE
  USING (is_account_member(account_id, 'admin'));
