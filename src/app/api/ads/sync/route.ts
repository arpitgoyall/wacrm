import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { syncMetaAds } from '@/lib/ads/meta-sync-run';

// POST /api/ads/sync — run the Meta Marketing API sync for the caller's
// account right now, bypassing the per-account hourly throttle ("Sync
// now" button). Admin+ only. The scheduled sync in
// /api/automations/cron covers the automatic case.

export const maxDuration = 60;

export async function POST() {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const summary = await syncMetaAds({ accountId: ctx.accountId, force: true });

  // A per-account failure is captured in `summary.errors` (and persisted
  // to `whatsapp_config.ad_sync_error`); surface it as a 502 so the UI
  // can show it, but still return the summary.
  const status = summary.errors.length > 0 ? 502 : 200;
  return NextResponse.json({ summary }, { status });
}
