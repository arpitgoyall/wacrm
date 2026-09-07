-- ============================================================
-- 057_web_push_notifications.sql
--
-- PWA / web-push delivery for the notification system.
--
--   1. `push_subscriptions` — one row per browser/device per user,
--      holding the W3C Push API endpoint + keys. Written by the
--      client via /api/push/subscribe, read by the server when
--      sending. Dead endpoints (404/410) are pruned by the sender.
--
--   2. `notifications.type` gains three new values so the same hub
--      table carries every alert kind.
--
--   3. `notification_push_config` — a single operator-populated row
--      with this deployment's base URL + the shared secret guarding
--      /api/push/dispatch. Left NULL by the migration; push stays a
--      silent no-op (in-app realtime still works) until it's filled.
--
--   4. AFTER INSERT trigger on `notifications` → pg_net POST to
--      /api/push/dispatch so a freshly-created notification reaches
--      the recipient's devices within a second, even with the app
--      closed. Non-blocking (pg_net queues + sends post-commit) and
--      wrapped so a delivery failure can never roll back the insert.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ------------------------------------------------------------
-- push_subscriptions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The Push Service URL. Globally unique — the same browser
  -- re-subscribing produces the same endpoint, so upsert on it.
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  failure_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A user fully manages their own device subscriptions. The dispatch
-- path reads them with the service-role client (RLS bypassed).
DROP POLICY IF EXISTS push_subscriptions_all ON push_subscriptions;
CREATE POLICY push_subscriptions_all ON push_subscriptions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ------------------------------------------------------------
-- notifications.type — widen the allowed set
-- ------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'new_message',
    'new_conversation',
    'sla_breach'
  ));

-- ------------------------------------------------------------
-- notification_push_config — one row, operator-populated
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_push_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- e.g. https://crm.example.com  (scheme + host, no trailing slash)
  base_url TEXT,
  -- must equal PUSH_HOOK_SECRET in the app's environment
  hook_secret TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notification_push_config (id) VALUES (TRUE)
  ON CONFLICT (id) DO NOTHING;

-- Service-role only: no policies + RLS on.
ALTER TABLE notification_push_config ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- dispatch trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notifications_dispatch_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
BEGIN
  SELECT base_url, hook_secret INTO v_base_url, v_secret
  FROM notification_push_config WHERE id = TRUE;

  -- Push not configured yet → no-op. In-app realtime still delivers.
  IF v_base_url IS NULL OR v_secret IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/api/push/dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    body := jsonb_build_object('notification_id', NEW.id::text),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Delivery is best-effort; never let it fail the notification insert.
  RAISE WARNING 'notifications_dispatch_push failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notifications_dispatch_push() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_notification_created ON notifications;
CREATE TRIGGER on_notification_created
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_dispatch_push();
