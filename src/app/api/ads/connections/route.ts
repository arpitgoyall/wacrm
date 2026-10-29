import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { discoverAccounts, saveConnection } from '@/lib/ads/workspace';
import { syncWorkspaceConnection } from '@/lib/ads/workspace-sync';
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from('ads_connections')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('name');
    if (error)
      return NextResponse.json(
        { error: 'Apply migration 073 to enable the campaign workspace' },
        { status: 503 }
      );
    const session = new URL(request.url).searchParams.get('session');
    let available: Awaited<ReturnType<typeof discoverAccounts>> = [];
    if (session) {
      await requireRole('admin');
      const { data: pending } = await supabaseAdmin()
        .from('ads_oauth_sessions')
        .select('token')
        .eq('id', session)
        .eq('account_id', ctx.accountId)
        .eq('user_id', ctx.userId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (pending?.token)
        available = await discoverAccounts(decrypt(pending.token));
    }
    return NextResponse.json({
      connections: data,
      available,
      oauthReady: Boolean(
        process.env.META_APP_ID &&
        process.env.META_APP_SECRET &&
        process.env.NEXT_PUBLIC_APP_URL
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json();
    if (body.action === 'sync' || body.action === 'backfill') {
      const result = await syncWorkspaceConnection(
        ctx.accountId,
        String(body.connectionId),
        body.action === 'backfill'
      );
      return NextResponse.json(result);
    }
    let token = typeof body.token === 'string' ? body.token : '';
    if (body.action === 'legacy') {
      const { data } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('ad_insights_token')
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!data?.ad_insights_token)
        return NextResponse.json(
          { error: 'No saved legacy ad token was found' },
          { status: 400 }
        );
      token = decrypt(data.ad_insights_token);
    } else if (body.session) {
      const { data } = await supabaseAdmin()
        .from('ads_oauth_sessions')
        .select('token')
        .eq('id', body.session)
        .eq('account_id', ctx.accountId)
        .eq('user_id', ctx.userId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (!data?.token)
        return NextResponse.json(
          { error: 'Meta connection session expired. Connect again.' },
          { status: 400 }
        );
      token = decrypt(data.token);
    }
    if (!token || token.length > 5000)
      return NextResponse.json(
        { error: 'Connect Meta or provide a valid access token' },
        { status: 400 }
      );
    if (!body.metaAccountId)
      return NextResponse.json({ available: await discoverAccounts(token) });
    const connection = await saveConnection(
      ctx.accountId,
      token,
      String(body.metaAccountId)
    );
    return NextResponse.json({ connection });
  } catch (err) {
    if (err instanceof Error && !('status' in err))
      return NextResponse.json({ error: err.message }, { status: 400 });
    return toErrorResponse(err);
  }
}
