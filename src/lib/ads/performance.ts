/**
 * CTWA ad performance — Phase 1 + Phase 2 ads-management reporting.
 *
 * Derives a per-ad funnel (leads -> deals -> won -> revenue) from the
 * `ctwa_ads` registry (migration 051), `contacts.ctwa_source_id` and
 * `deals.ctwa_source_id`, then layers on Meta Marketing API spend
 * (`ctwa_ad_insights`, migration 053) to give ROAS / CPL / cost-per-
 * deal and ad-set / campaign rollups.
 *
 * Attribution rules:
 *   - A lead is a contact whose `ctwa_source_id` names the ad. Last
 *     touch: the webhook overwrites `contacts.ctwa_source_id` on each
 *     ad tap, so a contact counts once, under the most recent ad.
 *   - A deal is attributed to its OWN `ctwa_source_id` snapshot (taken
 *     at creation by the `create_deal` automation step). Deals created
 *     by hand carry no snapshot, so they fall back to the contact's
 *     current `ctwa_source_id`.
 *   - `closeRate` is won deals / leads for that ad — deliberately over
 *     leads, not over deals, so an ad that generates lots of tyre-
 *     kickers is scored down.
 *   - `spend` is the sum of every `ctwa_ad_insights` row we hold for
 *     the ad. The sync keeps a rolling 30-day window fresh and never
 *     deletes, so spend history grows from the day sync was enabled —
 *     lifetime ROAS is only meaningful once ~30 days of history exist.
 *
 * The aggregation is a pure function so it can be unit-tested without a
 * Supabase mock; `loadAdPerformance` is the thin IO wrapper the page
 * calls with an RLS-scoped client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// Inputs (row shapes pulled from Supabase)
// ------------------------------------------------------------

export interface AdRegistryRow {
  id: string;
  source_id: string;
  label: string | null;
  headline: string | null;
  body: string | null;
  source_url: string | null;
  source_type: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** Meta structure (migration 053) — null until the ad account is
   *  connected and the sync has run. */
  campaign_id?: string | null;
  adset_id?: string | null;
  meta_name?: string | null;
  effective_status?: string | null;
}

export interface AdContactRow {
  id: string;
  ctwa_source_id: string | null;
  created_at: string;
}

export interface AdDealRow {
  contact_id: string | null;
  ctwa_source_id: string | null;
  value: number | string | null;
  status: string | null;
  created_at: string;
}

export interface AdInsightRow {
  ad_id: string;
  spend: number | string | null;
  impressions?: number | string | null;
  link_clicks?: number | string | null;
  messaging_started?: number | string | null;
  currency?: string | null;
}

export interface MetaCampaignRow {
  campaign_id: string;
  name: string | null;
}

export interface MetaAdsetRow {
  adset_id: string;
  name: string | null;
}

// ------------------------------------------------------------
// Output
// ------------------------------------------------------------

export interface AdPerformanceRow {
  /** `ctwa_ads.id` — null for an ad seen in contact/deal data that has
   *  no registry row yet (shouldn't happen after the 051 backfill, but
   *  handled so the row is never dropped). Rename is disabled when null. */
  id: string | null;
  source_id: string;
  label: string | null;
  headline: string | null;
  source_url: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  metaName: string | null;
  effectiveStatus: string | null;
  leads: number;
  deals: number;
  won: number;
  lost: number;
  open: number;
  revenue: number;
  spend: number;
  currency: string | null;
  /** won / leads, 0 when the ad has no leads. */
  closeRate: number;
  /** revenue / leads, 0 when the ad has no leads. */
  revenuePerLead: number;
  /** revenue / spend — null when we have no spend for the ad. */
  roas: number | null;
  /** spend / leads — null when no spend or no leads. */
  cpl: number | null;
  /** spend / deals — null when no spend or no deals. */
  cpd: number | null;
}

export interface AdPerformanceSummary {
  adCount: number;
  totalLeads: number;
  totalDeals: number;
  totalWon: number;
  totalRevenue: number;
  totalSpend: number;
  /** totalWon / totalLeads across all ads. */
  blendedCloseRate: number;
  /** totalRevenue / totalSpend — null when no spend is known. */
  blendedRoas: number | null;
  /** totalSpend / totalLeads — null when no spend is known. */
  blendedCpl: number | null;
}

export interface AdPerformance {
  rows: AdPerformanceRow[];
  summary: AdPerformanceSummary;
}

export type AdGroupBy = 'ad' | 'adset' | 'campaign';

export interface AdGroupRow {
  key: string;
  name: string;
  ads: number;
  leads: number;
  deals: number;
  won: number;
  revenue: number;
  spend: number;
  closeRate: number;
  roas: number | null;
  cpl: number | null;
}

// ------------------------------------------------------------
// Aggregation (pure)
// ------------------------------------------------------------

interface SourceStats {
  deals: number;
  won: number;
  lost: number;
  open: number;
  revenue: number;
}

function emptyStats(): SourceStats {
  return { deals: 0, won: 0, lost: 0, open: 0, revenue: 0 };
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function aggregateAdPerformance(
  ads: AdRegistryRow[],
  contacts: AdContactRow[],
  deals: AdDealRow[],
  insights: AdInsightRow[] = [],
  campaigns: MetaCampaignRow[] = [],
  adsets: MetaAdsetRow[] = []
): AdPerformance {
  const contactSourceById = new Map<string, string>();
  const leadsBySource = new Map<string, number>();
  for (const c of contacts) {
    if (!c.ctwa_source_id) continue;
    contactSourceById.set(c.id, c.ctwa_source_id);
    leadsBySource.set(
      c.ctwa_source_id,
      (leadsBySource.get(c.ctwa_source_id) ?? 0) + 1
    );
  }

  const statsBySource = new Map<string, SourceStats>();
  for (const d of deals) {
    const source =
      d.ctwa_source_id ??
      (d.contact_id ? contactSourceById.get(d.contact_id) : undefined);
    if (!source) continue;

    const stats = statsBySource.get(source) ?? emptyStats();
    stats.deals += 1;
    const status = d.status || 'open';
    if (status === 'won') {
      stats.won += 1;
      stats.revenue += toNum(d.value);
    } else if (status === 'lost') {
      stats.lost += 1;
    } else {
      stats.open += 1;
    }
    statsBySource.set(source, stats);
  }

  // Spend per ad id (sum every insights row we hold).
  const spendBySource = new Map<string, number>();
  const currencyBySource = new Map<string, string>();
  for (const ins of insights) {
    if (!ins.ad_id) continue;
    spendBySource.set(
      ins.ad_id,
      (spendBySource.get(ins.ad_id) ?? 0) + toNum(ins.spend)
    );
    if (ins.currency && !currencyBySource.has(ins.ad_id)) {
      currencyBySource.set(ins.ad_id, ins.currency);
    }
  }

  const campaignName = new Map(campaigns.map((c) => [c.campaign_id, c.name]));
  const adsetName = new Map(adsets.map((a) => [a.adset_id, a.name]));

  const registryBySource = new Map(ads.map((a) => [a.source_id, a]));
  const allSources = new Set<string>([
    ...registryBySource.keys(),
    ...leadsBySource.keys(),
    ...statsBySource.keys(),
    ...spendBySource.keys(),
  ]);

  const rows: AdPerformanceRow[] = [];
  for (const source of allSources) {
    const reg = registryBySource.get(source);
    const leads = leadsBySource.get(source) ?? 0;
    const stats = statsBySource.get(source) ?? emptyStats();
    const spend = spendBySource.get(source) ?? 0;
    const campId = reg?.campaign_id ?? null;
    const adsId = reg?.adset_id ?? null;
    rows.push({
      id: reg?.id ?? null,
      source_id: source,
      label: reg?.label ?? null,
      headline: reg?.headline ?? null,
      source_url: reg?.source_url ?? null,
      firstSeenAt: reg?.first_seen_at ?? null,
      lastSeenAt: reg?.last_seen_at ?? null,
      campaignId: campId,
      campaignName: campId ? (campaignName.get(campId) ?? null) : null,
      adsetId: adsId,
      adsetName: adsId ? (adsetName.get(adsId) ?? null) : null,
      metaName: reg?.meta_name ?? null,
      effectiveStatus: reg?.effective_status ?? null,
      leads,
      deals: stats.deals,
      won: stats.won,
      lost: stats.lost,
      open: stats.open,
      revenue: stats.revenue,
      spend,
      currency: currencyBySource.get(source) ?? null,
      closeRate: leads > 0 ? stats.won / leads : 0,
      revenuePerLead: leads > 0 ? stats.revenue / leads : 0,
      roas: spend > 0 ? stats.revenue / spend : null,
      cpl: spend > 0 && leads > 0 ? spend / leads : null,
      cpd: spend > 0 && stats.deals > 0 ? spend / stats.deals : null,
    });
  }

  // Busiest ads first; spend then revenue then ad id break ties so the
  // order is stable across reloads.
  rows.sort(
    (a, b) =>
      b.leads - a.leads ||
      b.spend - a.spend ||
      b.revenue - a.revenue ||
      a.source_id.localeCompare(b.source_id)
  );

  const totalLeads = rows.reduce((s, r) => s + r.leads, 0);
  const totalWon = rows.reduce((s, r) => s + r.won, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);

  const summary: AdPerformanceSummary = {
    adCount: rows.length,
    totalLeads,
    totalDeals: rows.reduce((s, r) => s + r.deals, 0),
    totalWon,
    totalRevenue,
    totalSpend,
    blendedCloseRate: totalLeads > 0 ? totalWon / totalLeads : 0,
    blendedRoas: ratio(totalRevenue, totalSpend),
    blendedCpl: ratio(totalSpend, totalLeads),
  };

  return { rows, summary };
}

/**
 * Roll the per-ad rows up by ad set or campaign (or pass them through
 * at ad level). Rows with no ad-set / campaign land in an
 * "(unassigned)" bucket rather than being dropped.
 */
export function groupAdPerformance(
  rows: AdPerformanceRow[],
  groupBy: AdGroupBy
): AdGroupRow[] {
  if (groupBy === 'ad') {
    return rows.map((r) => ({
      key: r.source_id,
      name: r.label || r.metaName || r.headline || r.source_id,
      ads: 1,
      leads: r.leads,
      deals: r.deals,
      won: r.won,
      revenue: r.revenue,
      spend: r.spend,
      closeRate: r.closeRate,
      roas: r.roas,
      cpl: r.cpl,
    }));
  }

  const UNASSIGNED = '__unassigned__';
  const groups = new Map<
    string,
    {
      name: string;
      ads: number;
      leads: number;
      deals: number;
      won: number;
      revenue: number;
      spend: number;
    }
  >();
  for (const r of rows) {
    const id = groupBy === 'campaign' ? r.campaignId : r.adsetId;
    const name = groupBy === 'campaign' ? r.campaignName : r.adsetName;
    const key = id ?? UNASSIGNED;
    const g = groups.get(key) ?? {
      name: name || id || '(unassigned)',
      ads: 0,
      leads: 0,
      deals: 0,
      won: 0,
      revenue: 0,
      spend: 0,
    };
    g.ads += 1;
    g.leads += r.leads;
    g.deals += r.deals;
    g.won += r.won;
    g.revenue += r.revenue;
    g.spend += r.spend;
    groups.set(key, g);
  }

  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      name: g.name,
      ads: g.ads,
      leads: g.leads,
      deals: g.deals,
      won: g.won,
      revenue: g.revenue,
      spend: g.spend,
      closeRate: g.leads > 0 ? g.won / g.leads : 0,
      roas: g.spend > 0 ? g.revenue / g.spend : null,
      cpl: g.spend > 0 && g.leads > 0 ? g.spend / g.leads : null,
    }))
    .sort(
      (a, b) =>
        b.leads - a.leads || b.spend - a.spend || a.name.localeCompare(b.name)
    );
}

// ------------------------------------------------------------
// IO wrapper
// ------------------------------------------------------------

export interface AdSyncMeta {
  /** `whatsapp_config.ad_sync_enabled`. */
  enabled: boolean;
  /** Ad account id is set (connection configured). */
  connected: boolean;
  syncedAt: string | null;
  error: string | null;
}

export interface AdPerformanceResult extends AdPerformance {
  sync: AdSyncMeta;
}

/**
 * Load the per-ad funnel for the caller's account. Uses the passed
 * client's RLS scoping (same pattern as `lib/dashboard/queries.ts`) —
 * every table read here is account-scoped by policy, so no explicit
 * `account_id` filter is needed.
 *
 * All client-side aggregation. Fine at the current scale; if a tenant
 * outgrows it this moves to a SQL view or RPC.
 */
export async function loadAdPerformance(
  db: SupabaseClient
): Promise<AdPerformanceResult> {
  const [
    adsRes,
    contactsRes,
    dealsRes,
    insightsRes,
    campaignsRes,
    adsetsRes,
    cfgRes,
  ] = await Promise.all([
    db
      .from('ctwa_ads')
      .select(
        'id, source_id, label, headline, body, source_url, source_type, first_seen_at, last_seen_at, campaign_id, adset_id, meta_name, effective_status'
      ),
    db
      .from('contacts')
      .select('id, ctwa_source_id, created_at')
      .not('ctwa_source_id', 'is', null),
    db
      .from('deals')
      .select('contact_id, ctwa_source_id, value, status, created_at'),
    db
      .from('ctwa_ad_insights')
      .select(
        'ad_id, spend, impressions, link_clicks, messaging_started, currency'
      ),
    db.from('meta_campaigns').select('campaign_id, name'),
    db.from('meta_adsets').select('adset_id, name'),
    db
      .from('whatsapp_config')
      .select('ad_account_id, ad_sync_enabled, ad_synced_at, ad_sync_error')
      .maybeSingle(),
  ]);

  if (adsRes.error) throw adsRes.error;
  if (contactsRes.error) throw contactsRes.error;
  if (dealsRes.error) throw dealsRes.error;
  // Insights / campaign / adset tables are optional context — if the
  // reads fail (older schema, RLS gap) fall back to no-spend rather than
  // failing the whole page.
  const insights = insightsRes.error
    ? []
    : ((insightsRes.data ?? []) as AdInsightRow[]);
  const campaigns = campaignsRes.error
    ? []
    : ((campaignsRes.data ?? []) as MetaCampaignRow[]);
  const adsets = adsetsRes.error
    ? []
    : ((adsetsRes.data ?? []) as MetaAdsetRow[]);

  const { rows, summary } = aggregateAdPerformance(
    (adsRes.data ?? []) as AdRegistryRow[],
    (contactsRes.data ?? []) as AdContactRow[],
    (dealsRes.data ?? []) as AdDealRow[],
    insights,
    campaigns,
    adsets
  );

  const cfg = (cfgRes.data ?? null) as {
    ad_account_id: string | null;
    ad_sync_enabled: boolean | null;
    ad_synced_at: string | null;
    ad_sync_error: string | null;
  } | null;

  return {
    rows,
    summary,
    sync: {
      enabled: Boolean(cfg?.ad_sync_enabled),
      connected: Boolean(cfg?.ad_account_id),
      syncedAt: cfg?.ad_synced_at ?? null,
      error: cfg?.ad_sync_error ?? null,
    },
  };
}
