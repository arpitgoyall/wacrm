-- ============================================================
-- 050_ctwa_conversions.sql
--
-- Send a conversion event back to Meta (Conversions API for Business
-- Messaging) when a counsellor moves a deal into a chosen pipeline
-- stage. Three pieces:
--
--   1. Durable CTWA click id. `flow_runs.vars.ctwa_clid` (migration
--      set by the flow engine on run start) is gone by the time a deal
--      closes days later, so the webhook now also persists the click id
--      + ad id on the CONTACT. `deals` carries a snapshot too, taken at
--      creation, so a contact with several deals attributes each one.
--
--   2. Conversions API credentials, per account, on `whatsapp_config`
--      alongside the existing WhatsApp access token: the Meta dataset
--      (pixel) id and a system-user token linked to it.
--
--   3. A deal-stage-change outbox (`deal_stage_events`) filled by an
--      AFTER UPDATE trigger on `deals`, drained by
--      /api/deals/stage-events/cron, which dispatches the new
--      `deal_stage_changed` automation trigger. A trigger + cron rather
--      than an API route so every existing client-side stage write
--      (pipeline board drag, inbox stage control, deal form) is covered
--      without touching those call sites.
--
--   `ctwa_conversion_dispatches` is the idempotency guard: one row per
--   (deal, stage, event_name), so dragging a deal out of the stage and
--   back never double-counts a conversion.
-- ============================================================

-- 1. Durable CTWA attribution -------------------------------------------------

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_source_id TEXT;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_source_id TEXT;

-- 2. Conversions API credentials --------------------------------------------

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS ctwa_dataset_id TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_capi_token TEXT;

-- 3a. Deal-stage-change outbox --------------------------------------------

CREATE TABLE IF NOT EXISTS deal_stage_events (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  pipeline_id UUID,
  from_stage_id UUID,
  to_stage_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Cron scans unprocessed rows oldest-first; partial index keeps that
-- scan cheap as the table grows with processed history.
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_unprocessed
  ON deal_stage_events (created_at)
  WHERE processed_at IS NULL;

-- Service-role only (the cron's supabaseAdmin() client). No policies →
-- anon/authenticated get nothing under RLS; service_role bypasses it.
-- Matches automation_logs / automation_round_robin_state.
ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION enqueue_deal_stage_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (
      account_id, deal_id, contact_id, pipeline_id, from_stage_id, to_stage_id
    )
    VALUES (
      NEW.account_id, NEW.id, NEW.contact_id, NEW.pipeline_id,
      OLD.stage_id, NEW.stage_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_deal_stage_event ON deals;
CREATE TRIGGER trg_enqueue_deal_stage_event
  AFTER UPDATE OF stage_id ON deals
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_deal_stage_event();

-- 3b. Conversion-event idempotency guard ----------------------------------

CREATE TABLE IF NOT EXISTS ctwa_conversion_dispatches (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL,
  event_name TEXT NOT NULL,
  automation_id UUID,
  ctwa_clid TEXT,
  response_status INT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, stage_id, event_name)
);

ALTER TABLE ctwa_conversion_dispatches ENABLE ROW LEVEL SECURITY;
