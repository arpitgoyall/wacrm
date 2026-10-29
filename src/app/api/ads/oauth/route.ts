import { randomBytes, createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { ADS_GRAPH_VERSION } from '@/lib/ads/graph';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const appId = process.env.META_APP_ID;
    const origin = process.env.NEXT_PUBLIC_APP_URL;
    if (!appId || !origin || !process.env.META_APP_SECRET)
      return NextResponse.json(
        {
          error:
            'Configure META_APP_ID, META_APP_SECRET and NEXT_PUBLIC_APP_URL to enable Meta login',
        },
        { status: 503 }
      );
    const state = randomBytes(32).toString('hex');
    const { error } = await supabaseAdmin()
      .from('ads_oauth_sessions')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        state_hash: createHash('sha256').update(state).digest('hex'),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    if (error) throw error;
    const url = new URL(
      `https://www.facebook.com/${ADS_GRAPH_VERSION}/dialog/oauth`
    );
    url.search = new URLSearchParams({
      client_id: appId,
      redirect_uri: `${origin.replace(/\/$/, '')}/api/ads/oauth/callback`,
      state,
      scope:
        'ads_read,ads_management,pages_show_list,pages_read_engagement,business_management',
      response_type: 'code',
    }).toString();
    const response = NextResponse.redirect(url);
    response.cookies.set('ads_oauth_state', state, {
      httpOnly: true,
      secure: origin.startsWith('https:'),
      sameSite: 'lax',
      path: '/api/ads/oauth',
      maxAge: 900,
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
