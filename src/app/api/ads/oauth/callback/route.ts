import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { ADS_GRAPH_VERSION } from '@/lib/ads/graph';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;
    const state = params.get('state') || '';
    const cookie = (await cookies()).get('ads_oauth_state')?.value || '';
    if (
      !cookie ||
      state.length !== cookie.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
    )
      return NextResponse.json(
        { error: 'Invalid Meta connection state' },
        { status: 400 }
      );
    const db = supabaseAdmin();
    const { data: session } = await db
      .from('ads_oauth_sessions')
      .update({ consumed_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .eq('state_hash', createHash('sha256').update(state).digest('hex'))
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('id')
      .maybeSingle();
    if (!session || !params.get('code'))
      return NextResponse.json(
        { error: 'Meta login was cancelled or expired' },
        { status: 400 }
      );
    const origin = process.env.NEXT_PUBLIC_APP_URL!.replace(/\/$/, '');
    const body = new URLSearchParams({
      client_id: process.env.META_APP_ID!,
      client_secret: process.env.META_APP_SECRET!,
      code: params.get('code')!,
      redirect_uri: `${origin}/api/ads/oauth/callback`,
    });
    const result = await fetch(
      `https://graph.facebook.com/${ADS_GRAPH_VERSION}/oauth/access_token`,
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(20_000),
        cache: 'no-store',
      }
    );
    const token = await result.json();
    if (!result.ok || !token.access_token)
      return NextResponse.json(
        { error: 'Meta token exchange failed. Reconnect your account.' },
        { status: 400 }
      );
    const { error } = await db
      .from('ads_oauth_sessions')
      .update({ token: encrypt(token.access_token) })
      .eq('id', session.id);
    if (error) throw error;
    const response = NextResponse.redirect(
      `${origin}/ads?section=settings&connect_session=${session.id}`
    );
    response.cookies.delete('ads_oauth_state');
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
