-- Call attempts counter on pipeline lead cards.
--
-- Counsellors tap − / + on a deal card to record how many times they've
-- tried calling the lead. Starts at 0 and never goes negative.

alter table public.deals
  add column if not exists call_attempts integer not null default 0;

alter table public.deals
  drop constraint if exists deals_call_attempts_nonnegative;
alter table public.deals
  add constraint deals_call_attempts_nonnegative check (call_attempts >= 0);

-- Atomic +/- so two teammates tapping at once don't overwrite each other
-- (a read-then-write from the browser would lose one of the taps).
-- SECURITY INVOKER: the deals_update RLS policy still decides who may
-- change which deal; a deal the caller can't see returns NULL.
create or replace function public.adjust_deal_call_attempts(
  p_deal_id uuid,
  p_delta integer
)
returns integer
language sql
security invoker
set search_path = public
as $$
  update public.deals
     set call_attempts = greatest(0, call_attempts + greatest(-1, least(1, p_delta)))
   where id = p_deal_id
  returning call_attempts;
$$;

revoke all on function public.adjust_deal_call_attempts(uuid, integer) from public, anon;
grant execute on function public.adjust_deal_call_attempts(uuid, integer) to authenticated;
