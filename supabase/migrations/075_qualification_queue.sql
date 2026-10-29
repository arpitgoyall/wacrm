CREATE TABLE IF NOT EXISTS ads_rule_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  dirty_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,contact_id)
);
ALTER TABLE ads_rule_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ads_rule_queue FROM anon,authenticated;
CREATE OR REPLACE FUNCTION ads_mark_rule_dirty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cid uuid; aid uuid;
BEGIN
  IF TG_TABLE_NAME='contacts' THEN cid=NEW.id; ELSE cid=NEW.contact_id; END IF;
  SELECT account_id INTO aid FROM contacts WHERE id=cid;
  IF aid IS NOT NULL THEN INSERT INTO ads_rule_queue(account_id,contact_id) VALUES(aid,cid)
    ON CONFLICT(account_id,contact_id) DO UPDATE SET dirty_at=now(); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ads_rules_dirty ON contacts;
CREATE TRIGGER ads_rules_dirty AFTER INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION ads_mark_rule_dirty();
DROP TRIGGER IF EXISTS ads_rules_dirty ON contact_custom_values;
CREATE TRIGGER ads_rules_dirty AFTER INSERT OR UPDATE ON contact_custom_values FOR EACH ROW EXECUTE FUNCTION ads_mark_rule_dirty();
DROP TRIGGER IF EXISTS ads_rules_dirty ON deals;
CREATE TRIGGER ads_rules_dirty AFTER INSERT OR UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION ads_mark_rule_dirty();
DROP TRIGGER IF EXISTS ads_rules_dirty ON flow_runs;
CREATE TRIGGER ads_rules_dirty AFTER INSERT OR UPDATE ON flow_runs FOR EACH ROW EXECUTE FUNCTION ads_mark_rule_dirty();
