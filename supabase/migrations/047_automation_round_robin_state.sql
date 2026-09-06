-- ============================================================
-- 047_automation_round_robin_state.sql
--
-- Round-robin agent assignment (assign_conversation / assign_deal)
-- needs a per-(automation, agent pool) cursor that advances
-- atomically across concurrent executions.
--
-- automations.execution_count (migration 007) can't be reused for
-- this: the engine reads it once at dispatch time and only
-- increments it via RPC AFTER all steps finish, so two contacts
-- triggering the same automation within the same window both read
-- the same stale count and land on the same agent instead of
-- rotating. This table + function give round-robin assignment its
-- own atomically-incrementing cursor, independent of that
-- user-visible run-count stat.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_round_robin_state (
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  pool_key TEXT NOT NULL,
  cursor BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (automation_id, pool_key)
);

-- Service-role only (the engine's supabaseAdmin() client). No policies
-- means anon/authenticated get zero access under RLS; service_role
-- bypasses RLS entirely, matching automation_logs / automation_pending_executions.
ALTER TABLE automation_round_robin_state ENABLE ROW LEVEL SECURITY;

-- Atomically advances the cursor for (automation_id, pool_key) and
-- returns the resulting index into a pool of size p_pool_size.
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single
-- statement, so concurrent callers serialize on the row lock instead
-- of racing on a read-then-write.
CREATE OR REPLACE FUNCTION next_round_robin_index(
  p_automation_id UUID,
  p_pool_key TEXT,
  p_pool_size INT
)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO automation_round_robin_state AS s (automation_id, pool_key, cursor)
  VALUES (p_automation_id, p_pool_key, 0)
  ON CONFLICT (automation_id, pool_key)
  DO UPDATE SET cursor = s.cursor + 1
  RETURNING (cursor % GREATEST(p_pool_size, 1))::INT;
$$;

REVOKE ALL ON FUNCTION next_round_robin_index(UUID, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_round_robin_index(UUID, TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION next_round_robin_index(UUID, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION next_round_robin_index(UUID, TEXT, INT) TO service_role;
