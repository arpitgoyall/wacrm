-- Tracks reminders per waiting node. The flow cron claims each attempt
-- with a guarded update before sending, preventing duplicate cron sends.
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS follow_up_attempts INTEGER NOT NULL DEFAULT 0;
