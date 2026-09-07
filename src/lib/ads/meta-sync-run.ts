/**
 * Meta Marketing API sync runner (Phase 2 ads-management).
 *
 * Pulls campaign / ad-set / ad structure and per-day ad insights for
 * every account that has connected an ad account
 * (`whatsapp_config.ad_sync_enabled`), and:
 *
 *   - upserts `meta_campaigns` / `meta_adsets` (rollup labels),
 *   - enriches existing `ctwa_ads` rows (matched on `source_id =
 *     ad.id`) with their campaign / ad-set / status,
 *   - upserts `ctwa_ad_insights` (spend + messaging metrics per ad per
 *     day) over a rolling window.
 *
 * Called from `/api/automations/cron`. Self-throttled: an account
 * synced less than `MIN_INTERVAL_MS` ago is skipped, so the Marketing
 * API is hit at most hourly no matter how often the cron fires. Pass
 * `force: true` (manual "Sync now") to bypass that.
 *
 * Never throws — a per-account failure is recorded on
 * `whatsapp_config.ad_sync_error` and the loop moves on.
 */

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  buildEdgeUrl,
  buildInsightsUrl,
  parseInsightsRow,
  rollingWindow,
  type RawInsightsRow,
} from './meta-sync';

const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INSIGHTS_WINDOW_DAYS = 30;
const MAX_PAGES = 25;
const UPSERT_CHUNK = 500;

export interface MetaSyncOptions {
  /** Limit the run to one account (manual "Sync now"). */
  accountId?: string;
  /** Ignore the per-account throttle. */
  force?: boolean;
}

export interface MetaSyncSummary {
  accountsSynced: number;
  accountsSkipped: number;
  campaigns: number;
  adsets: number;
  adsMatched: number;
  insightRows: number;
  errors: string[];
}

interface ConfigRow {
  account_id: string;
  ad_account_id: string | null;
  ad_insights_token: string | null;
  ad_synced_at: string | null;
}

export async function syncMetaAds(
  opts: MetaSyncOptions = {}
): Promise<MetaSyncSummary> {
  const admin = supabaseAdmin();
  const summary: MetaSyncSummary = {
    accountsSynced: 0,
    accountsSkipped: 0,
    campaigns: 0,
    adsets: 0,
    adsMatched: 0,
    insightRows: 0,
    errors: [],
  };

  let query = admin
    .from('whatsapp_config')
    .select('account_id, ad_account_id, ad_insights_token, ad_synced_at')
    .eq('ad_sync_enabled', true);
  if (opts.accountId) query = query.eq('account_id', opts.accountId);

  const { data: configs, error } = await query;
  if (error) {
    summary.errors.push(`config scan failed: ${error.message}`);
    return summary;
  }

  const now = Date.now();
  for (const cfg of (configs ?? []) as ConfigRow[]) {
    if (!cfg.ad_account_id || !cfg.ad_insights_token) {
      summary.accountsSkipped += 1;
      continue;
    }
    if (
      !opts.force &&
      cfg.ad_synced_at &&
      now - new Date(cfg.ad_synced_at).getTime() < MIN_INTERVAL_MS
    ) {
      summary.accountsSkipped += 1;
      continue;
    }

    try {
      await syncOneAccount(admin, cfg, summary);
      await admin
        .from('whatsapp_config')
        .update({ ad_synced_at: new Date().toISOString(), ad_sync_error: null })
        .eq('account_id', cfg.account_id);
      summary.accountsSynced += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${cfg.account_id}: ${msg}`);
      await admin
        .from('whatsapp_config')
        .update({ ad_sync_error: msg.slice(0, 500) })
        .eq('account_id', cfg.account_id);
    }
  }

  return summary;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

async function syncOneAccount(
  admin: Admin,
  cfg: ConfigRow,
  summary: MetaSyncSummary
) {
  const token = decrypt(cfg.ad_insights_token as string);
  const adAccountId = cfg.ad_account_id as string;
  const accountId = cfg.account_id;

  // --- Campaigns -------------------------------------------------------
  const campaigns = await fetchAll<{
    id: string;
    name?: string;
    objective?: string;
    status?: string;
    effective_status?: string;
    daily_budget?: string;
  }>(
    (after) =>
      buildEdgeUrl({
        adAccountId,
        edge: 'campaigns',
        fields: [
          'name',
          'objective',
          'status',
          'effective_status',
          'daily_budget',
        ],
        after,
      }),
    token
  );
  if (campaigns.length > 0) {
    await chunkedUpsert(
      admin,
      'meta_campaigns',
      'account_id,campaign_id',
      campaigns.map((c) => ({
        account_id: accountId,
        campaign_id: c.id,
        name: c.name ?? null,
        objective: c.objective ?? null,
        status: c.status ?? null,
        effective_status: c.effective_status ?? null,
        daily_budget: c.daily_budget ? Number(c.daily_budget) : null,
        updated_at: new Date().toISOString(),
      }))
    );
    summary.campaigns += campaigns.length;
  }

  // --- Ad sets --------------------------------------------------------
  const adsets = await fetchAll<{
    id: string;
    name?: string;
    campaign_id?: string;
    status?: string;
    effective_status?: string;
    daily_budget?: string;
  }>(
    (after) =>
      buildEdgeUrl({
        adAccountId,
        edge: 'adsets',
        fields: [
          'name',
          'campaign_id',
          'status',
          'effective_status',
          'daily_budget',
        ],
        after,
      }),
    token
  );
  if (adsets.length > 0) {
    await chunkedUpsert(
      admin,
      'meta_adsets',
      'account_id,adset_id',
      adsets.map((a) => ({
        account_id: accountId,
        adset_id: a.id,
        campaign_id: a.campaign_id ?? null,
        name: a.name ?? null,
        status: a.status ?? null,
        effective_status: a.effective_status ?? null,
        daily_budget: a.daily_budget ? Number(a.daily_budget) : null,
        updated_at: new Date().toISOString(),
      }))
    );
    summary.adsets += adsets.length;
  }

  // --- Registry ads we already have a row for ------------------------
  const { data: knownAds } = await admin
    .from('ctwa_ads')
    .select('source_id')
    .eq('account_id', accountId);
  const known = new Set<string>(
    ((knownAds ?? []) as { source_id: string }[]).map((r) => r.source_id)
  );
  if (known.size === 0) return; // nothing to enrich or cost

  const ads = await fetchAll<{
    id: string;
    name?: string;
    adset_id?: string;
    campaign_id?: string;
    effective_status?: string;
  }>(
    (after) =>
      buildEdgeUrl({
        adAccountId,
        edge: 'ads',
        fields: ['name', 'adset_id', 'campaign_id', 'effective_status'],
        after,
      }),
    token
  );
  const nowIso = new Date().toISOString();
  for (const ad of ads) {
    if (!known.has(ad.id)) continue;
    await admin
      .from('ctwa_ads')
      .update({
        campaign_id: ad.campaign_id ?? null,
        adset_id: ad.adset_id ?? null,
        meta_name: ad.name ?? null,
        effective_status: ad.effective_status ?? null,
        meta_synced_at: nowIso,
      })
      .eq('account_id', accountId)
      .eq('source_id', ad.id);
    summary.adsMatched += 1;
  }

  // --- Insights (rolling window, per ad per day) --------------------
  const win = rollingWindow(INSIGHTS_WINDOW_DAYS);
  const rawRows = await fetchAll<RawInsightsRow>(
    (after) => buildInsightsUrl({ adAccountId, ...win, after }),
    token
  );
  const insightRows = rawRows
    .map(parseInsightsRow)
    .filter((r): r is NonNullable<typeof r> => r !== null && known.has(r.adId))
    .map((r) => ({
      account_id: accountId,
      ad_id: r.adId,
      date: r.date,
      spend: r.spend,
      impressions: r.impressions,
      link_clicks: r.linkClicks,
      messaging_started: r.messagingStarted,
      currency: r.currency,
      updated_at: nowIso,
    }));
  if (insightRows.length > 0) {
    await chunkedUpsert(
      admin,
      'ctwa_ad_insights',
      'account_id,ad_id,date',
      insightRows
    );
    summary.insightRows += insightRows.length;
  }
}

/**
 * Follow Graph API `paging.cursors.after` until exhausted or MAX_PAGES.
 * Token goes in the Authorization header (not the querystring) so it is
 * not captured in request logs.
 */
async function fetchAll<T>(
  makeUrl: (after?: string) => string,
  token: string
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(makeUrl(after), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: T[];
      error?: { message?: string };
      paging?: { cursors?: { after?: string }; next?: string };
    } | null;
    if (!json) throw new Error(`Meta API returned non-JSON (${res.status})`);
    if (json.error) throw new Error(json.error.message ?? 'Meta API error');
    if (Array.isArray(json.data)) out.push(...json.data);
    const next = json.paging?.next;
    after = json.paging?.cursors?.after;
    if (!next || !after) break;
  }
  return out;
}

async function chunkedUpsert(
  admin: Admin,
  table: string,
  onConflict: string,
  rows: Record<string, unknown>[]
) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await admin.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}
