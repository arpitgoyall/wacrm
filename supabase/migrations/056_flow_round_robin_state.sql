-- ============================================================
-- 056_flow_round_robin_state.sql
--
-- Round-robin agent assignment for the flow `handoff` node needs a
-- per-(flow, agent pool) cursor that advances atomically across
-- concurrent runs — the same problem migration 047 solved for the
-- automations engine's assign_conversation / assign_deal steps.
--
-- A parallel table (rather than reusing automation_round_robin_state)
-- keeps the automations path untouched and lets the cursor cascade
-- with the flow it belongs to.
-- ============================================================

CREATE TABLE IF NOT EXISTS flow_round_robin_state (
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  pool_key TEXT NOT NULL,
  cursor BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (flow_id, pool_key)
);

-- Service-role only (the flows engine's supabaseAdmin() client), same
-- posture as automation_round_robin_state: RLS on, no policies.
ALTER TABLE flow_round_robin_state ENABLE ROW LEVEL SECURITY;

-- Atomically advances the cursor for (flow_id, pool_key) and returns
-- the resulting index into a pool of size p_pool_size. Single-statement
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING so concurrent callers
-- serialize on the row lock instead of racing a read-then-write.
CREATE OR REPLACE FUNCTION next_flow_round_robin_index(
  p_flow_id UUID,
  p_pool_key TEXT,
  p_pool_size INT
)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO flow_round_robin_state AS s (flow_id, pool_key, cursor)
  VALUES (p_flow_id, p_pool_key, 0)
  ON CONFLICT (flow_id, pool_key)
  DO UPDATE SET cursor = s.cursor + 1
  RETURNING (cursor % GREATEST(p_pool_size, 1))::INT;
$$;

REVOKE ALL ON FUNCTION next_flow_round_robin_index(UUID, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_flow_round_robin_index(UUID, TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION next_flow_round_robin_index(UUID, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION next_flow_round_robin_index(UUID, TEXT, INT) TO service_role;
