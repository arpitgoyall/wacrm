import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  campaignIdentities,
  prepareCampaignChange,
  applyCampaignChange,
} from '@/lib/ads/campaign-actions';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { reconcileCampaignChange } from '@/lib/ads/campaign-reconcile';

export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    return NextResponse.json(
      await campaignIdentities(
        ctx.accountId,
        new URL(request.url).searchParams.get('connection') || ''
      )
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }
  try {
    const body = await request.json();
    if (body.cancel && typeof body.requestId === 'string') {
      const { error } = await supabaseAdmin()
        .from('ads_change_requests')
        .update({ status: 'cancelled' })
        .eq('account_id', ctx.accountId)
        .eq('id', body.requestId)
        .in('status', ['review', 'failed']);
      if (error) throw error;
      return NextResponse.json({ cancelled: true });
    }
    if (body.reconcile && typeof body.requestId === 'string')
      return NextResponse.json(
        await reconcileCampaignChange(
          ctx.accountId,
          body.requestId,
          body.remoteId
        )
      );
    if (body.approve === true && typeof body.requestId === 'string')
      return NextResponse.json(
        await applyCampaignChange(ctx.accountId, body.requestId, ctx.userId)
      );
    return NextResponse.json({
      review: await prepareCampaignChange(ctx.accountId, ctx.userId, body),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Campaign operation failed',
      },
      { status: 400 }
    );
  }
}
