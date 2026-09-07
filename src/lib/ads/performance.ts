/**
 * CTWA ad performance — Phase 1 ads-management reporting.
 *
 * Derives a per-ad funnel (leads -> deals -> won -> revenue) entirely
 * from data the CRM already has: the `ctwa_ads` registry (migration
 * 051), `contacts.ctwa_source_id`, and `deals.ctwa_source_id`. No Meta
 * Marketing API call — that (spend, ROAS, CPL) is Phase 2.
 *
 * Attribution rules:
 *   - A lead is a contact whose `ctwa_source_id` names the ad. Last
 *     touch: the webhook overwrites `contacts.ctwa_source_id` on each
 *     ad tap, so a contact counts once, under the most recent ad.
 *   - A deal is attributed to its OWN `ctwa_source_id` snapshot (taken
 *     at creation by the `create_deal` automation step). Deals created
 *     by hand carry no snapshot, so they fall back to the contact's
 *     current `ctwa_source_id`.
 *   - `close_rate` is won deals / leads for that ad — deliberately over
 *     leads, not over deals, so an ad that generates lots of tyre-
 *     kickers is scored down.
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
  leads: number;
  deals: number;
  won: number;
  lost: number;
  open: number;
  revenue: number;
  /** won / leads, 0 when the ad has no leads. */
  closeRate: number;
  /** revenue / leads, 0 when the ad has no leads. */
  revenuePerLead: number;
}

export interface AdPerformanceSummary {
  adCount: number;
  totalLeads: number;
  totalDeals: number;
  totalWon: number;
  totalRevenue: number;
  /** totalWon / totalLeads across all ads. */
  blendedCloseRate: number;
}

export interface AdPerformance {
  rows: AdPerformanceRow[];
  summary: AdPerformanceSummary;
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

export function aggregateAdPerformance(
  ads: AdRegistryRow[],
  contacts: AdContactRow[],
  deals: AdDealRow[]
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
      stats.revenue += Number(d.value) || 0;
    } else if (status === 'lost') {
      stats.lost += 1;
    } else {
      stats.open += 1;
    }
    statsBySource.set(source, stats);
  }

  // Every ad id we know about, from any of the three sources.
  const registryBySource = new Map(ads.map((a) => [a.source_id, a]));
  const allSources = new Set<string>([
    ...registryBySource.keys(),
    ...leadsBySource.keys(),
    ...statsBySource.keys(),
  ]);

  const rows: AdPerformanceRow[] = [];
  for (const source of allSources) {
    const reg = registryBySource.get(source);
    const leads = leadsBySource.get(source) ?? 0;
    const stats = statsBySource.get(source) ?? emptyStats();
    rows.push({
      id: reg?.id ?? null,
      source_id: source,
      label: reg?.label ?? null,
      headline: reg?.headline ?? null,
      source_url: reg?.source_url ?? null,
      firstSeenAt: reg?.first_seen_at ?? null,
      lastSeenAt: reg?.last_seen_at ?? null,
      leads,
      deals: stats.deals,
      won: stats.won,
      lost: stats.lost,
      open: stats.open,
      revenue: stats.revenue,
      closeRate: leads > 0 ? stats.won / leads : 0,
      revenuePerLead: leads > 0 ? stats.revenue / leads : 0,
    });
  }

  // Busiest ads first; revenue then ad id break ties so the order is
  // stable across reloads.
  rows.sort(
    (a, b) =>
      b.leads - a.leads ||
      b.revenue - a.revenue ||
      a.source_id.localeCompare(b.source_id)
  );

  const summary: AdPerformanceSummary = {
    adCount: rows.length,
    totalLeads: rows.reduce((s, r) => s + r.leads, 0),
    totalDeals: rows.reduce((s, r) => s + r.deals, 0),
    totalWon: rows.reduce((s, r) => s + r.won, 0),
    totalRevenue: rows.reduce((s, r) => s + r.revenue, 0),
    blendedCloseRate: 0,
  };
  summary.blendedCloseRate =
    summary.totalLeads > 0 ? summary.totalWon / summary.totalLeads : 0;

  return { rows, summary };
}

// ------------------------------------------------------------
// IO wrapper
// ------------------------------------------------------------

/**
 * Load the per-ad funnel for the caller's account. Uses the passed
 * client's RLS scoping (same pattern as `lib/dashboard/queries.ts`) —
 * `ctwa_ads`, `contacts` and `deals` are all account-scoped by policy,
 * so no explicit `account_id` filter is needed here.
 *
 * All client-side aggregation. Fine at the current scale (low
 * thousands of contacts / deals); if a tenant outgrows it this moves
 * to a SQL view or RPC.
 */
export async function loadAdPerformance(
  db: SupabaseClient
): Promise<AdPerformance> {
  const [adsRes, contactsRes, dealsRes] = await Promise.all([
    db
      .from('ctwa_ads')
      .select(
        'id, source_id, label, headline, body, source_url, source_type, first_seen_at, last_seen_at'
      ),
    db
      .from('contacts')
      .select('id, ctwa_source_id, created_at')
      .not('ctwa_source_id', 'is', null),
    db
      .from('deals')
      .select('contact_id, ctwa_source_id, value, status, created_at'),
  ]);

  if (adsRes.error) throw adsRes.error;
  if (contactsRes.error) throw contactsRes.error;
  if (dealsRes.error) throw dealsRes.error;

  return aggregateAdPerformance(
    (adsRes.data ?? []) as AdRegistryRow[],
    (contactsRes.data ?? []) as AdContactRow[],
    (dealsRes.data ?? []) as AdDealRow[]
  );
}
