-- Move all scheduled jobs from Vercel Cron to Supabase (pg_cron + pg_net).
--
-- pg_cron ticks inside Postgres and uses pg_net to call the app's existing
-- cron endpoints with `Authorization: Bearer <CRON_SECRET>` — the same
-- credential `checkCronAuth` already accepts, so no app auth change is needed.
--
-- ONE-TIME SETUP (run once in the SQL editor, with your real values; they are
-- stored encrypted in Supabase Vault, never in this migration):
--
--   select vault.create_secret('https://your-app-domain.com', 'app_url');
--   select vault.create_secret('<same value as the CRON_SECRET env var>', 'cron_secret');
--
-- To change a value later: select vault.update_secret(id, 'new') from
-- vault.secrets where name = 'app_url';

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fires one authenticated GET at an app cron path. Fire-and-forget: pg_net
-- performs the HTTP call asynchronously, so a slow endpoint never blocks the
-- scheduler. Response status/body land in net._http_response for debugging.
create or replace function public.invoke_app_cron(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'app_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_secret' limit 1;

  if v_url is null or v_secret is null then
    raise warning 'invoke_app_cron(%): vault secrets app_url / cron_secret are not set', p_path;
    return null;
  end if;

  return net.http_get(
    url := rtrim(v_url, '/') || p_path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 55000
  );
end;
$$;

revoke all on function public.invoke_app_cron(text) from public, anon, authenticated;

-- cron.schedule upserts by job name, so re-running this migration is safe.
select cron.schedule('app-automations', '* * * * *',
  $$select public.invoke_app_cron('/api/automations/cron')$$);
select cron.schedule('app-broadcasts', '* * * * *',
  $$select public.invoke_app_cron('/api/broadcasts/cron')$$);
select cron.schedule('app-ads', '* * * * *',
  $$select public.invoke_app_cron('/api/ads/cron')$$);
select cron.schedule('app-flows', '*/5 * * * *',
  $$select public.invoke_app_cron('/api/flows/cron')$$);
