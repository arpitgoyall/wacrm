-- Campaign workspace. Public metadata is separated from server-only credentials.
CREATE TABLE IF NOT EXISTS ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meta_account_id text NOT NULL, name text NOT NULL, currency text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC', permissions jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'connected', error text,
  synced_at timestamptz, history_start date, backfill_until date,
  sync_claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,meta_account_id), UNIQUE(account_id,id)
);
CREATE TABLE IF NOT EXISTS ads_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES ads_connections(id) ON DELETE CASCADE,
  token text NOT NULL
);
ALTER TABLE ads_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ads_connection_secrets FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS ads_oauth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id), state_hash text NOT NULL,
  token text, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE ads_oauth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ads_oauth_sessions FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS ads_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  connection_id uuid NOT NULL, meta_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('campaign','adset','ad')),
  parent_id text, name text NOT NULL, status text, data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,connection_id) REFERENCES ads_connections(account_id,id) ON DELETE CASCADE,
  UNIQUE(connection_id,kind,meta_id)
);
CREATE TABLE IF NOT EXISTS ads_daily_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  connection_id uuid NOT NULL, ad_id text NOT NULL, date date NOT NULL,
  spend numeric NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0, messaging bigint NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY(account_id,connection_id) REFERENCES ads_connections(account_id,id) ON DELETE CASCADE,
  UNIQUE(connection_id,ad_id,date)
);
CREATE INDEX IF NOT EXISTS ads_daily_period ON ads_daily_insights(account_id,connection_id,date);
CREATE TABLE IF NOT EXISTS ads_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('draft','creative','view','report','experiment','note','rules','decision')),
  name text NOT NULL, data jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ads_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('qualified','unqualified')),
  reason text NOT NULL, source text NOT NULL CHECK(source IN ('rule','staff')),
  actor_id uuid REFERENCES auth.users(id), occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ads_qualification_contact ON ads_qualifications(account_id,contact_id,occurred_at);
CREATE TABLE IF NOT EXISTS ads_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id), deal_id uuid REFERENCES deals(id),
  sale_key text NOT NULL, value numeric NOT NULL CHECK(value >= 0), currency text NOT NULL,
  source text NOT NULL CHECK(source IN ('staff','payment')),
  status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','refunded')),
  occurred_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES auth.users(id), UNIQUE(account_id,sale_key)
);
CREATE TABLE IF NOT EXISTS ads_conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  outcome_key text NOT NULL, contact_id uuid NOT NULL REFERENCES contacts(id),
  event_name text NOT NULL CHECK(event_name IN ('LeadSubmitted','Purchase')),
  ctwa_clid text, value numeric, currency text, occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed','skipped')),
  attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz, reason text, delivered_at timestamptz,
  UNIQUE(account_id,outcome_key)
);
CREATE TABLE IF NOT EXISTS ads_conversion_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES ads_conversion_events(id),
  status integer, accepted boolean NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ads_conversion_events ADD COLUMN IF NOT EXISTS duplicate_suppressed_count integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ads_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL, entity_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('status','budget','duplicate','publish')),
  before_data jsonb NOT NULL DEFAULT '{}', after_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'review' CHECK(status IN ('review','processing','applied','failed','uncertain')),
  remote_ids jsonb NOT NULL DEFAULT '{}', error text,
  actor_id uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,connection_id) REFERENCES ads_connections(account_id,id)
);
CREATE TABLE IF NOT EXISTS ads_integration_keys (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  secret_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ads_integration_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ads_integration_keys FROM anon, authenticated;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ads_connections','ads_entities','ads_daily_insights','ads_documents','ads_qualifications','ads_sales','ads_conversion_events','ads_conversion_attempts','ads_change_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_read ON %I',t);
    EXECUTE format('CREATE POLICY workspace_read ON %I FOR SELECT USING (is_account_member(account_id))',t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM anon, authenticated',t);
  END LOOP;
END $$;

-- Immutable message milestones, avoiding expensive message-history scans for response metrics.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ads_first_customer_at timestamptz,
  ADD COLUMN IF NOT EXISTS ads_customer_messages integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_first_human_at timestamptz,
  ADD COLUMN IF NOT EXISTS ads_first_bot_at timestamptz;
CREATE OR REPLACE FUNCTION ads_message_milestone() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.sender_type='customer' THEN
    UPDATE conversations SET ads_first_customer_at=COALESCE(ads_first_customer_at,NEW.created_at),ads_customer_messages=ads_customer_messages+1 WHERE id=NEW.conversation_id;
  ELSIF NEW.sender_type='agent' THEN
    UPDATE conversations SET ads_first_human_at=COALESCE(ads_first_human_at,NEW.created_at) WHERE id=NEW.conversation_id AND ads_first_customer_at IS NOT NULL;
  ELSIF NEW.sender_type='bot' THEN
    UPDATE conversations SET ads_first_bot_at=COALESCE(ads_first_bot_at,NEW.created_at) WHERE id=NEW.conversation_id AND ads_first_customer_at IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ads_message_milestone ON messages;
CREATE TRIGGER ads_message_milestone AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION ads_message_milestone();
-- Historical message data can supply real milestones; do not invent timestamps.
UPDATE conversations c SET ads_first_customer_at=m.first_customer, ads_first_human_at=m.first_human, ads_first_bot_at=m.first_bot
FROM (SELECT conversation_id,min(created_at) FILTER(WHERE sender_type='customer') first_customer,
 min(created_at) FILTER(WHERE sender_type='agent') first_human,min(created_at) FILTER(WHERE sender_type='bot') first_bot
 FROM messages GROUP BY conversation_id) m WHERE c.id=m.conversation_id AND c.ads_first_customer_at IS NULL;
UPDATE conversations c SET ads_customer_messages=m.total FROM (SELECT conversation_id,count(*)::integer total FROM messages WHERE sender_type='customer' GROUP BY conversation_id) m WHERE c.id=m.conversation_id;
