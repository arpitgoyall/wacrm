-- ============================================================
-- 055_ctwa_ad_bindings_automation.sql
--
-- Extend the Phase 3 ad → Flow bindings (migration 054) so a binding
-- can target an AUTOMATION instead of a Flow. A CTWA lead from a bound
-- ad then runs that automation directly (bypassing trigger matching),
-- the same way a flow binding starts a flow.
--
-- Exactly one of `flow_id` / `automation_id` is set per binding — the
-- CHECK enforces it. `flow_id` loses its NOT NULL so an automation
-- binding can leave it null.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ctwa_ad_bindings
  ADD COLUMN IF NOT EXISTS automation_id uuid
    REFERENCES automations(id) ON DELETE CASCADE;

ALTER TABLE ctwa_ad_bindings
  ALTER COLUMN flow_id DROP NOT NULL;

-- Exactly one target. Drop-then-add so re-running the migration
-- re-installs it cleanly.
ALTER TABLE ctwa_ad_bindings
  DROP CONSTRAINT IF EXISTS ctwa_ad_bindings_one_target;
ALTER TABLE ctwa_ad_bindings
  ADD CONSTRAINT ctwa_ad_bindings_one_target
  CHECK ((flow_id IS NULL) <> (automation_id IS NULL));
