import { supabaseAdmin } from '@/lib/automations/admin-client';
import { graphPages, type GraphObject } from './graph';
import { connectionToken, type AdConnection } from './workspace';
import { parseInsightsRow, type RawInsightsRow } from './meta-sync';

function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export async function syncWorkspaceConnection(
  accountId: string,
  id: string,
  backfill = false
) {
  const db = supabaseAdmin();
  const { connection, token } = await connectionToken(accountId, id);
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: claim, error: claimError } = await db
    .from('ads_connections')
    .update({ sync_claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .or(`sync_claimed_at.is.null,sync_claimed_at.lt.${stale}`)
    .select('id')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claim) return { skipped: true };
  try {
    const campaigns = await graphPages<GraphObject>(
      `${connection.meta_account_id}/campaigns`,
      token,
      {
        fields:
          'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,special_ad_categories',
      }
    );
    const adsets = await graphPages<GraphObject>(
      `${connection.meta_account_id}/adsets`,
      token,
      {
        fields:
          'id,name,campaign_id,status,effective_status,destination_type,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,targeting,promoted_object',
      }
    );
    const eligibleSets = adsets.filter(
      (a) => a.destination_type === 'WHATSAPP'
    );
    const setIds = new Set(eligibleSets.map((a) => a.id));
    const campaignIds = new Set(eligibleSets.map((a) => a.campaign_id));
    const ads = await graphPages<GraphObject>(
      `${connection.meta_account_id}/ads`,
      token,
      {
        fields:
          'id,name,adset_id,campaign_id,status,effective_status,creative{id,title,body,image_url,thumbnail_url,video_id,object_story_spec}',
      }
    );
    const eligibleAds = ads.filter((a) => setIds.has(a.adset_id));
    const records = [
      ...campaigns
        .filter((c) => campaignIds.has(c.id))
        .map((c) => ({ ...c, kind: 'campaign', parent: null })),
      ...eligibleSets.map((a) => ({
        ...a,
        kind: 'adset',
        parent: String(a.campaign_id),
      })),
      ...eligibleAds.map((a) => ({
        ...a,
        kind: 'ad',
        parent: String(a.adset_id),
      })),
    ].map((c) => ({
      account_id: accountId,
      connection_id: id,
      meta_id: String((c as GraphObject).id),
      name: String((c as GraphObject).name || (c as GraphObject).id),
      kind: c.kind,
      parent_id: c.parent,
      status: String(
        (c as GraphObject).effective_status || (c as GraphObject).status
      ),
      data: c,
      updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < records.length; i += 250) {
      const { error } = await db
        .from('ads_entities')
        .upsert(records.slice(i, i + 250), {
          onConflict: 'connection_id,kind,meta_id',
        });
      if (error) throw error;
    }
    // Read one bounded backfill slice per call; persist its cursor only after all pages succeed.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: connection.timezone,
    });
    const until = backfill
      ? connection.backfill_until || shift(today, -30)
      : today;
    const since = shift(until, backfill ? -6 : -29);
    const raw = await graphPages<RawInsightsRow>(
      `${connection.meta_account_id}/insights`,
      token,
      {
        level: 'ad',
        time_increment: 1,
        fields:
          'ad_id,spend,impressions,inline_link_clicks,actions,account_currency',
        time_range: { since, until },
      }
    );
    const adIds = new Set(eligibleAds.map((a) => String(a.id)));
    const daily = raw
      .map(parseInsightsRow)
      .filter((r): r is NonNullable<typeof r> =>
        Boolean(r && adIds.has(r.adId))
      )
      .map((r) => ({
        account_id: accountId,
        connection_id: id,
        ad_id: r.adId,
        date: r.date,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.linkClicks,
        messaging: r.messagingStarted,
      }));
    const { error: reconcileError } = await db.rpc('ads_replace_insights', {
      p_account: accountId,
      p_connection: id,
      p_start: since,
      p_end: until,
      p_rows: daily,
    });
    if (reconcileError) throw reconcileError;
    const { error } = await db
      .from('ads_connections')
      .update({
        synced_at: new Date().toISOString(),
        history_start:
          connection.history_start && connection.history_start < since
            ? connection.history_start
            : since,
        backfill_until: backfill ? shift(since, -1) : connection.backfill_until,
        status: 'connected',
        error: null,
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) throw error;
    return {
      entities: records.length,
      days: backfill ? 7 : 30,
      rows: daily.length,
      since,
      until,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Meta sync failed';
    await db
      .from('ads_connections')
      .update({ error: error.slice(0, 500) })
      .eq('id', id)
      .eq('account_id', accountId);
    throw Error(error);
  } finally {
    await db
      .from('ads_connections')
      .update({ sync_claimed_at: null })
      .eq('id', id)
      .eq('account_id', accountId);
  }
}
export async function syncWorkspaceAccounts() {
  const { data, error } = await supabaseAdmin()
    .from('ads_connections')
    .select('*')
    .or(
      `synced_at.is.null,synced_at.lt.${new Date(Date.now() - 3600_000).toISOString()}`
    )
    .order('synced_at', { ascending: true, nullsFirst: true })
    .limit(2);
  if (error) return { synced: 0, unavailable: true };
  const results = [];
  for (const c of (data || []) as AdConnection[]) {
    try {
      results.push(await syncWorkspaceConnection(c.account_id, c.id));
    } catch {
      results.push({ failed: true });
    }
  }
  return { synced: results.length, results };
}
