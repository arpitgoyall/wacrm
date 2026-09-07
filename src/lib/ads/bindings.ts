/**
 * CTWA ad → Flow bindings (Phase 3 ads-management).
 *
 * `resolveBoundFlow` is called by the WhatsApp webhook when an inbound
 * carries an ad referral and the contact has no active flow run. It
 * returns the flow id bound to that ad (or its campaign), or null.
 *
 * Resolution order: an ad-level binding wins over a campaign-level one.
 * The campaign lookup needs `ctwa_ads.campaign_id`, which is only
 * populated once the Marketing API sync (migration 053) has run — until
 * then only ad-level bindings resolve.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function resolveBoundFlow(
  db: Db,
  accountId: string,
  adId: string
): Promise<string | null> {
  try {
    // 1. Ad-level binding.
    const { data: adBinding } = await db
      .from('ctwa_ad_bindings')
      .select('flow_id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('match_type', 'ad')
      .eq('match_value', adId)
      .maybeSingle();
    if (adBinding?.flow_id) return adBinding.flow_id as string;

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
      .select('flow_id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('match_type', 'campaign')
      .eq('match_value', campaignId)
      .maybeSingle();
    return (campBinding?.flow_id as string | undefined) ?? null;
  } catch (err) {
    console.error('[ads] resolveBoundFlow failed:', err);
    return null;
  }
}
