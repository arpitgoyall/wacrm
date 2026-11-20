-- Stream deal changes to the inbox.
--
-- The inbox conversation list shows each contact's pipeline stage and
-- subscribes to postgres_changes on `deals`, but the table was never
-- added to the realtime publication, so stage moves made by teammates,
-- the AI agent or automations only appeared after a page reload.
-- Realtime still applies the deals_select RLS policy per subscriber.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'deals'
  ) then
    alter publication supabase_realtime add table public.deals;
  end if;
end $$;
