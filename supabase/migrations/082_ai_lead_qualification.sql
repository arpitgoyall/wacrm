-- ============================================================
-- 082_ai_lead_qualification.sql — AI lead outcomes, lead card, smarter
-- follow-ups.
--
-- ai_configs
--   qualification_pipeline_id + stage_*_id — where the AI moves a lead's
--     open deal for each outcome (all optional; null = don't move).
--   qualification_criteria — the account's own definition of "qualified"
--     (falls back to a built-in default when empty).
--   followup_send_start_hour / followup_send_end_hour / proactive_timezone —
--     quiet hours for promotional follow-ups.
--
-- contacts.ai_lead_card — what the AI has learned about the lead (name,
--   occupation, goal, experience, intent, objection, city).
--
-- conversations
--   ai_outcome / ai_outcome_at — qualified | lost | not_responding. Follow-ups
--     stop once set.
--   last_customer_message_at — drives the 24h free-form window check
--     (maintained by trigger, backfilled here).
--
-- Idempotent.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS qualification_pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_qualified_id        uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_lost_id             uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_not_responding_id   uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_follow_up_id        uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qualification_criteria    text,
  ADD COLUMN IF NOT EXISTS followup_send_start_hour  integer NOT NULL DEFAULT 9
    CHECK (followup_send_start_hour BETWEEN 0 AND 23),
  ADD COLUMN IF NOT EXISTS followup_send_end_hour    integer NOT NULL DEFAULT 21
    CHECK (followup_send_end_hour BETWEEN 1 AND 24),
  ADD COLUMN IF NOT EXISTS proactive_timezone        text NOT NULL DEFAULT 'Asia/Kolkata';

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_lead_card jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_outcome text
    CHECK (ai_outcome IN ('qualified', 'lost', 'not_responding')),
  ADD COLUMN IF NOT EXISTS ai_outcome_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;

UPDATE conversations c
SET last_customer_message_at = m.last_at
FROM (
  SELECT conversation_id, max(created_at) AS last_at
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_customer_message_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_followup_window
  ON conversations (account_id, last_customer_message_at)
  WHERE ai_outcome IS NULL;

-- Extend the customer-message trigger from 081: also stamp the window clock.
CREATE OR REPLACE FUNCTION public.reset_ai_followup_on_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET ai_followup_count = 0,
      last_customer_message_at = GREATEST(
        COALESCE(last_customer_message_at, NEW.created_at), NEW.created_at)
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;
