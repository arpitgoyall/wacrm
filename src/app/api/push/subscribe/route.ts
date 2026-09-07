import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

// Device push-subscription registry.
//
//   POST   /api/push/subscribe   — upsert this browser's subscription
//   DELETE /api/push/subscribe   — remove it (on unsubscribe / sign-out)
//
// Any signed-in member can register their own device. The dispatch
// path reads these rows with the service-role client.

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = await request.json().catch(() => null);

    const endpoint =
      body && typeof body.endpoint === 'string' ? body.endpoint : '';
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || typeof p256dh !== 'string' || typeof auth !== 'string') {
      return NextResponse.json(
        { error: 'endpoint and keys.p256dh / keys.auth are required' },
        { status: 400 },
      );
    }
    const userAgent =
      typeof body?.user_agent === 'string'
        ? body.user_agent.slice(0, 400)
        : null;

    const { error } = await supabaseAdmin()
      .from('push_subscriptions')
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          endpoint,
          p256dh,
          auth,
          user_agent: userAgent,
          failure_count: 0,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' },
      );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = await request.json().catch(() => null);
    const endpoint =
      body && typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint required' }, { status: 400 });
    }
    // Scope the delete to the caller so one user can't drop another's
    // device even if they somehow learn the endpoint.
    await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', ctx.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
