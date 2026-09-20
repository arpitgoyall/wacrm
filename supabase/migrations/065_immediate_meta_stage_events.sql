-- Deliver built-in Meta conversion events immediately through a Supabase
-- Database Webhook instead of the automation cron.

ALTER TABLE deal_stage_events
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE deal_stage_events
  DROP CONSTRAINT IF EXISTS deal_stage_events_delivery_status_check;
ALTER TABLE deal_stage_events
  ADD CONSTRAINT deal_stage_events_delivery_status_check
  CHECK (delivery_status IN ('pending', 'processing', 'sent', 'skipped', 'failed'));

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_delivery_status
  ON deal_stage_events (delivery_status, created_at);

-- Meta conversion reporting is now built in: Qualified -> LeadSubmitted and
-- Enrolled -> Purchase. Remove the obsolete automation action and delete
-- automations that existed solely to host that action.
DELETE FROM automations a
WHERE EXISTS (
  SELECT 1 FROM automation_steps s
  WHERE s.automation_id = a.id AND s.step_type = 'send_meta_capi_event'
)
AND NOT EXISTS (
  SELECT 1 FROM automation_steps s
  WHERE s.automation_id = a.id AND s.step_type <> 'send_meta_capi_event'
);

DELETE FROM automation_steps WHERE step_type = 'send_meta_capi_event';
