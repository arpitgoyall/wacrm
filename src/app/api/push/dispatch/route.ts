import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendPushToUser } from '@/lib/push/send';
import {
  notificationToPushPayload,
  type NotificationRowForPush,
} from '@/lib/push/payload';

// Internal fan-out endpoint. Called by the `on_notification_created`
// Postgres trigger via pg_net (migration 057) with the shared secret
// from `notification_push_config.hook_secret`, which must match
// PUSH_HOOK_SECRET here. Not for browsers.

function authorized(request: Request): boolean {
  const expected = process.env.PUSH_HOOK_SECRET;
  if (!expected) return false;
  const supplied = request.headers.get('x-push-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const id =
    body && typeof body.notification_id === 'string'
      ? body.notification_id
      : '';
  if (!id) {
    return NextResponse.json(
      { error: 'notification_id required' },
      { status: 400 },
    );
  }

  const { data: n, error } = await supabaseAdmin()
    .from('notifications')
    .select('id, user_id, type, title, body, conversation_id')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!n) {
    return NextResponse.json({ ok: true, skipped: 'not_found' });
  }

  const result = await sendPushToUser(
    n.user_id as string,
    notificationToPushPayload(n as unknown as NotificationRowForPush),
  );
  return NextResponse.json({ ok: true, ...result });
}
