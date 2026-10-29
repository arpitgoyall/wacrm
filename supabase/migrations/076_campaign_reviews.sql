ALTER TABLE ads_change_requests DROP CONSTRAINT IF EXISTS ads_change_requests_status_check;
ALTER TABLE ads_change_requests ADD CONSTRAINT ads_change_requests_status_check
 CHECK(status IN ('review','processing','applied','failed','uncertain','cancelled'));
ALTER TABLE ads_change_requests ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id),
 ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ads_publish_once ON ads_change_requests(account_id,entity_id)
 WHERE action='publish' AND status IN ('review','processing','uncertain','applied');
CREATE UNIQUE INDEX IF NOT EXISTS ads_contacts_workspace_id ON contacts(account_id,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ads_qualifications','ads_sales','ads_conversion_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=t||'_contact_workspace') THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(account_id,contact_id) REFERENCES contacts(account_id,id)',t,t||'_contact_workspace');
  END IF;
 END LOOP;
END $$;
