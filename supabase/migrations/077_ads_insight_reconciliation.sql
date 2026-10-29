CREATE OR REPLACE FUNCTION ads_replace_insights(p_account uuid,p_connection uuid,p_start date,p_end date,p_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ads_connections WHERE id=p_connection AND account_id=p_account) THEN RAISE EXCEPTION 'Connection not found'; END IF;
 IF p_start>p_end OR p_end-p_start>31 THEN RAISE EXCEPTION 'Invalid insight window'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE (r->>'date')::date NOT BETWEEN p_start AND p_end) THEN RAISE EXCEPTION 'Insight is outside the requested window'; END IF;
 DELETE FROM ads_daily_insights WHERE account_id=p_account AND connection_id=p_connection AND date BETWEEN p_start AND p_end;
 INSERT INTO ads_daily_insights(account_id,connection_id,ad_id,date,spend,impressions,clicks,messaging)
 SELECT p_account,p_connection,r->>'ad_id',(r->>'date')::date,(r->>'spend')::numeric,(r->>'impressions')::bigint,(r->>'clicks')::bigint,(r->>'messaging')::bigint
 FROM jsonb_array_elements(p_rows) r;
END $$;
REVOKE ALL ON FUNCTION ads_replace_insights(uuid,uuid,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ads_replace_insights(uuid,uuid,date,date,jsonb) TO service_role;
