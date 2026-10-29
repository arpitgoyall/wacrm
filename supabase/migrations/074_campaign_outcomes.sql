CREATE TABLE IF NOT EXISTS ads_sale_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id),
  sale_id uuid NOT NULL REFERENCES ads_sales(id), before_data jsonb, after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ads_sale_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_read ON ads_sale_audit;
CREATE POLICY workspace_read ON ads_sale_audit FOR SELECT USING(is_account_member(account_id));
REVOKE INSERT,UPDATE,DELETE ON ads_sale_audit FROM anon,authenticated;

CREATE OR REPLACE FUNCTION ads_queue_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE click_id text; event_type text; outcome text; event_value numeric; event_currency text;
BEGIN
  SELECT ctwa_clid INTO click_id FROM contacts WHERE id=NEW.contact_id AND account_id=NEW.account_id;
  IF TG_TABLE_NAME='ads_qualifications' THEN
    IF NEW.status<>'qualified' THEN RETURN NEW; END IF;
    event_type='LeadSubmitted'; outcome='qualified:'||NEW.contact_id::text;
  ELSE
    INSERT INTO ads_sale_audit(account_id,sale_id,before_data,after_data)
      VALUES(NEW.account_id,NEW.id,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
    IF NEW.status<>'confirmed' THEN
      UPDATE ads_conversion_events SET status='skipped',reason='Sale was refunded before delivery'
        WHERE account_id=NEW.account_id AND outcome_key='sale:'||NEW.id::text AND status IN ('pending','failed','skipped');
      RETURN NEW;
    END IF;
    IF NEW.deal_id IS NOT NULL THEN
      SELECT COALESCE(ctwa_clid,click_id) INTO click_id FROM deals WHERE id=NEW.deal_id AND account_id=NEW.account_id;
    END IF;
    event_type='Purchase'; outcome='sale:'||NEW.id::text; event_value=NEW.value; event_currency=NEW.currency;
  END IF;
  INSERT INTO ads_conversion_events(account_id,outcome_key,contact_id,event_name,ctwa_clid,value,currency,occurred_at)
    VALUES(NEW.account_id,outcome,NEW.contact_id,event_type,click_id,event_value,event_currency,NEW.occurred_at)
    ON CONFLICT(account_id,outcome_key) DO UPDATE SET
      duplicate_suppressed_count=ads_conversion_events.duplicate_suppressed_count+1,
      value=CASE WHEN ads_conversion_events.attempt_count=0 THEN EXCLUDED.value ELSE ads_conversion_events.value END,
      currency=CASE WHEN ads_conversion_events.attempt_count=0 THEN EXCLUDED.currency ELSE ads_conversion_events.currency END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ads_queue_qualified ON ads_qualifications;
CREATE TRIGGER ads_queue_qualified AFTER INSERT ON ads_qualifications FOR EACH ROW EXECUTE FUNCTION ads_queue_outcome();
DROP TRIGGER IF EXISTS ads_queue_sale ON ads_sales;
CREATE TRIGGER ads_queue_sale AFTER INSERT OR UPDATE ON ads_sales FOR EACH ROW EXECUTE FUNCTION ads_queue_outcome();

CREATE OR REPLACE FUNCTION ads_confirm_sale(p_account uuid,p_contact uuid,p_deal uuid,p_key text,p_value numeric,p_currency text,p_source text,p_status text,p_actor uuid,p_time timestamptz)
RETURNS ads_sales LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE sale ads_sales;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=p_contact AND account_id=p_account) THEN RAISE EXCEPTION 'Contact not found'; END IF;
  IF p_deal IS NOT NULL AND NOT EXISTS(SELECT 1 FROM deals WHERE id=p_deal AND contact_id=p_contact AND account_id=p_account) THEN RAISE EXCEPTION 'Deal not found'; END IF;
  INSERT INTO ads_sales(account_id,contact_id,deal_id,sale_key,value,currency,source,status,actor_id,occurred_at)
    VALUES(p_account,p_contact,p_deal,p_key,p_value,p_currency,p_source,p_status,p_actor,p_time)
    ON CONFLICT(account_id,sale_key) DO NOTHING;
  SELECT * INTO sale FROM ads_sales WHERE account_id=p_account AND sale_key=p_key FOR UPDATE;
  IF sale.contact_id<>p_contact OR sale.deal_id IS DISTINCT FROM p_deal THEN RAISE EXCEPTION 'Sale identity conflicts with an existing confirmation'; END IF;
  IF sale.source='payment' AND p_source='staff' THEN RETURN sale; END IF;
  IF (sale.value,sale.currency,sale.source,sale.status) IS DISTINCT FROM (p_value,p_currency,p_source,p_status) THEN
    UPDATE ads_sales SET value=p_value,currency=p_currency,source=p_source,status=p_status,actor_id=p_actor,updated_at=now() WHERE id=sale.id RETURNING * INTO sale;
  ELSE
    UPDATE ads_conversion_events SET duplicate_suppressed_count=duplicate_suppressed_count+1 WHERE account_id=p_account AND outcome_key='sale:'||sale.id::text;
  END IF;
  RETURN sale;
END $$;
REVOKE ALL ON FUNCTION ads_confirm_sale(uuid,uuid,uuid,text,numeric,text,text,text,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ads_confirm_sale(uuid,uuid,uuid,text,numeric,text,text,text,uuid,timestamptz) TO service_role;
