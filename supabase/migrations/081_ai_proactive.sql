-- ============================================================
-- 081_ai_proactive.sql — AI agent: new-lead outreach + re-engagement
--
-- Account settings (ai_configs):
--   outreach_*  — first touch for brand-new leads. A cold lead has no open
--                 24h WhatsApp window, so the opener MUST be an approved
--                 template; the AI takes over (existing auto-reply) once
--                 the lead replies.
--   followup_*  — human-like nudges for conversations that went quiet.
--                 Inside the 24h window the AI writes free text; outside
--                 it, the optional followup template is sent instead.
--   *_enabled_at — set when a feature is switched on so we never blast
--                 contacts/conversations that pre-date it.
--
-- Per-conversation state (conversations):
--   ai_followup_count    — nudges sent since the customer last wrote
--                          (reset by trigger on any customer message)
--   ai_followup_disabled — sticky stop (opt-out / handoff)
--   ai_outreach_sent_at  — claim marker so a lead is opened exactly once
--
-- Idempotent.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outreach_enabled              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outreach_enabled_at           timestamptz,
  ADD COLUMN IF NOT EXISTS outreach_template_name        text,
  ADD COLUMN IF NOT EXISTS outreach_delay_minutes        integer NOT NULL DEFAULT 5
    CHECK (outreach_delay_minutes BETWEEN 0 AND 1440),
  ADD COLUMN IF NOT EXISTS followup_enabled              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS followup_enabled_at           timestamptz,
  ADD COLUMN IF NOT EXISTS followup_template_name        text,
  ADD COLUMN IF NOT EXISTS followup_first_delay_hours    integer NOT NULL DEFAULT 4
    CHECK (followup_first_delay_hours BETWEEN 1 AND 720),
  ADD COLUMN IF NOT EXISTS followup_interval_hours       integer NOT NULL DEFAULT 24
    CHECK (followup_interval_hours BETWEEN 1 AND 720),
  ADD COLUMN IF NOT EXISTS followup_max_attempts         integer NOT NULL DEFAULT 3
    CHECK (followup_max_attempts BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS proactive_template_language   text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS proactive_daily_cap           integer NOT NULL DEFAULT 100
    CHECK (proactive_daily_cap BETWEEN 1 AND 5000);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_followup_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_followup_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_outreach_sent_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversations_ai_outreach_sent
  ON conversations (account_id, ai_outreach_sent_at)
  WHERE ai_outreach_sent_at IS NOT NULL;

-- A customer message restarts the follow-up sequence.
CREATE OR REPLACE FUNCTION public.reset_ai_followup_on_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET ai_followup_count = 0
  WHERE id = NEW.conversation_id AND ai_followup_count <> 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_reset_ai_followup ON public.messages;
CREATE TRIGGER messages_reset_ai_followup
AFTER INSERT ON public.messages
FOR EACH ROW
WHEN (NEW.sender_type = 'customer')
EXECUTE FUNCTION public.reset_ai_followup_on_customer_message();

-- Schedule the proactive sweep (requires the helper from migration 080).
select cron.schedule('app-ai-proactive', '*/5 * * * *',
  $$select public.invoke_app_cron('/api/ai/proactive/cron')$$);
