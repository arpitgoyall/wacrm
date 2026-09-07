/**
 * CTWA ad → Flow / Automation bindings (Phase 3 ads-management,
 * migrations 054 + 055).
 *
 * `resolveAdBinding` is called by the WhatsApp webhook when an inbound
 * carries an ad referral. It returns the binding target for that ad (or
 * its campaign), or null.
 *
 * Resolution order: an ad-level binding wins over a campaign-level one.
 * The campaign lookup needs `ctwa_ads.campaign_id`, which is only
 * populated once the Marketing API sync (migration 053) has run — until
 * then only ad-level bindings resolve.
 *
 * Exactly one of `flow_id` / `automation_id` is set on a returned
 * binding (the DB CHECK enforces it).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface AdBindingTarget {
  flow_id: string | null;
  automation_id: string | null;
}

export async function resolveAdBinding(
  db: Db,
  accountId: string,
  adId: string
): Promise<AdBindingTarget | null> {
  try {
    const select = 'flow_id, automation_id';

    // 1. Ad-level binding.
    const { data: adBinding } = await db
      .from('ctwa_ad_bindings')
      .select(select)
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('match_type', 'ad')
      .eq('match_value', adId)
      .maybeSingle();
    if (adBinding) return normalize(adBinding);

    // 2. Campaign-level binding — needs the ad's campaign id from the
    //    registry (set by the Marketing API sync).
    const { data: adRow } = await db
      .from('ctwa_ads')
      .select('campaign_id')
      .eq('account_id', accountId)
      .eq('source_id', adId)
      .maybeSingle();
    const campaignId = (adRow as { campaign_id: string | null } | null)
      ?.campaign_id;
    if (!campaignId) return null;

    const { data: campBinding } = await db
      .from('ctwa_ad_bindings')
      .select(select)
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('match_type', 'campaign')
      .eq('match_value', campaignId)
      .maybeSingle();
    return campBinding ? normalize(campBinding) : null;
  } catch (err) {
    console.error('[ads] resolveAdBinding failed:', err);
    return null;
  }
}

function normalize(row: {
  flow_id?: string | null;
  automation_id?: string | null;
}): AdBindingTarget {
  return {
    flow_id: row.flow_id ?? null,
    automation_id: row.automation_id ?? null,
  };
}
