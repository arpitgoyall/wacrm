-- ============================================================
-- 052_ctwa_click_events.sql
--
-- Phase 0 of the CTWA ads work: stop losing ad-click history.
--
-- Migration 050 persists the ad id + click id on the CONTACT, but
-- last-touch: each ad tap overwrites the previous one, so a contact
-- who clicked three ads over two weeks looks like they only ever
-- clicked the last. That is fine for Conversions API recency but
-- destroys first-touch / multi-touch reporting and the "which ad did
-- this lead actually come from" question a rep asks in the contact
-- view.
--
--   1. `ctwa_click_events` — one append-only row per ad tap (Meta
--      attaches `referral` to the first inbound after each tap). The
--      webhook writes it alongside the existing last-touch contact
--      update. Never updated or deleted.
--
--   2. `contacts.ctwa_headline` / `ctwa_source_url` — the creative
--      context for the LAST ad the contact tapped, denormalised onto
--      the contact so the detail view can show "came from the '50%
--      off launch' ad" without a join. Kept in step with the existing
--      `ctwa_clid` / `ctwa_source_id` columns.
--
-- RLS: settings-class read for any member; the webhook's service-role
-- client does the writes and bypasses RLS, so there is no
-- INSERT/UPDATE/DELETE policy.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Append-only click log -------------------------------------------------

CREATE TABLE IF NOT EXISTS ctwa_click_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Meta's `referral.source_id` (the ad id) and `ctwa_clid` (click id).
  ad_id        text,
  clid         text,
  -- Creative context Meta attached to this specific tap.
  headline     text,
  body         text,
  source_url   text,
  source_type  text,
  media_type   text,
  -- When the inbound that carried this referral was sent (Meta message
  -- timestamp), falling back to insert time.
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ctwa_click_events_account_contact_idx
  ON ctwa_click_events (account_id, contact_id);
CREATE INDEX IF NOT EXISTS ctwa_click_events_account_ad_idx
  ON ctwa_click_events (account_id, ad_id);

ALTER TABLE ctwa_click_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ctwa_click_events_select ON ctwa_click_events;
CREATE POLICY ctwa_click_events_select ON ctwa_click_events FOR SELECT
  USING (is_account_member(account_id));

-- 2. Creative context on the contact (last touch) ------------------------

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_headline TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_source_url TEXT;
