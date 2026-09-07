/**
 * Meta Marketing API — pure helpers for the ad-structure + insights
 * sync (Phase 2 ads-management). No network here; the runner in
 * `meta-sync-run.ts` composes these with `fetch` and Supabase writes so
 * URL-building and the insights-row shape stay unit-testable.
 */

/** Graph API version for the Marketing API calls. Bump deliberately. */
export const META_GRAPH_VERSION = 'v21.0';

const GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/**
 * `actions[].action_type` values that count as "a messaging
 * conversation was started from this ad". Meta reports the same idea
 * under a few keys depending on optimisation + attribution window; we
 * take the largest single matching value per row rather than summing
 * (they overlap).
 */
export const MESSAGING_ACTION_TYPES = [
  'onsite_conversion.total_messaging_connection',
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.messaging_first_reply',
] as const;

/** Normalise "act_123" / "123" to the "act_123" the Graph path wants. */
export function normalizeAdAccountId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

export interface EdgeUrlInput {
  adAccountId: string;
  /** e.g. "campaigns" | "adsets" | "ads" */
  edge: string;
  fields: string[];
  limit?: number;
  /** Graph paging cursor (`paging.cursors.after`). */
  after?: string;
}

export function buildEdgeUrl(input: EdgeUrlInput): string {
  const acct = normalizeAdAccountId(input.adAccountId);
  const params = new URLSearchParams({
    fields: input.fields.join(','),
    limit: String(input.limit ?? 200),
  });
  if (input.after) params.set('after', input.after);
  return `${GRAPH_BASE}/${acct}/${input.edge}?${params.toString()}`;
}

export interface InsightsUrlInput {
  adAccountId: string;
  /** Inclusive YYYY-MM-DD. */
  since: string;
  until: string;
  limit?: number;
  after?: string;
}

export function buildInsightsUrl(input: InsightsUrlInput): string {
  const acct = normalizeAdAccountId(input.adAccountId);
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    fields:
      'ad_id,spend,impressions,inline_link_clicks,actions,account_currency',
    time_range: JSON.stringify({ since: input.since, until: input.until }),
    limit: String(input.limit ?? 500),
  });
  if (input.after) params.set('after', input.after);
  return `${GRAPH_BASE}/${acct}/insights?${params.toString()}`;
}

/** Inclusive `[since, until]` window ending today (local), `days` wide. */
export function rollingWindow(
  days: number,
  now: Date = new Date()
): { since: string; until: string } {
  const until = ymd(now);
  const start = new Date(now);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return { since: ymd(start), until };
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ------------------------------------------------------------
// Insights row parsing
// ------------------------------------------------------------

export interface RawInsightsRow {
  ad_id?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string | number;
  impressions?: string | number;
  inline_link_clicks?: string | number;
  account_currency?: string;
  actions?: Array<{ action_type?: string; value?: string | number }>;
}

export interface ParsedInsightsRow {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  messagingStarted: number;
  currency: string | null;
}

/**
 * Flatten one `level=ad&time_increment=1` insights row. Returns null
 * when the row has no `ad_id` / `date_start` (a totals row, or a shape
 * Meta changed under us) so the caller can skip it.
 */
export function parseInsightsRow(
  row: RawInsightsRow
): ParsedInsightsRow | null {
  if (!row.ad_id || !row.date_start) return null;

  const messaging = Math.max(
    0,
    ...(row.actions ?? [])
      .filter((a) =>
        (MESSAGING_ACTION_TYPES as readonly string[]).includes(
          a.action_type ?? ''
        )
      )
      .map((a) => num(a.value)),
    0
  );

  return {
    adId: String(row.ad_id),
    date: row.date_start,
    spend: num(row.spend),
    impressions: num(row.impressions),
    linkClicks: num(row.inline_link_clicks),
    messagingStarted: messaging,
    currency: row.account_currency ?? null,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
