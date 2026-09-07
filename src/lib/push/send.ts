import webpush from 'web-push';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import type { PushPayload } from './payload';

// VAPID is configured once per process, lazily, from env. When the keys
// are absent the sender becomes a silent no-op — in-app realtime still
// delivers, and the operator can add push later without a redeploy of
// this module's callers.
let vapidReady: boolean | null = null;

function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:notifications@wacrm.local';
  if (!publicKey || !privateKey) {
    vapidReady = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidReady = true;
  return true;
}

/** True when VAPID keys are present and push can actually be sent. */
export function isPushConfigured(): boolean {
  return ensureVapid();
}

/**
 * Fan a payload out to every registered device for `userId`. Endpoints
 * the push service reports as gone (404 / 410) are deleted so the table
 * self-heals. Never throws.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number; skipped: boolean }> {
  if (!ensureVapid()) return { sent: 0, pruned: 0, skipped: true };

  const db = supabaseAdmin();
  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error || !subs || subs.length === 0) {
    return { sent: 0, pruned: 0, skipped: false };
  }

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint as string,
            keys: { p256dh: s.p256dh as string, auth: s.auth as string },
          },
          body,
          { TTL: 600, urgency: 'high' },
        );
        sent += 1;
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'statusCode' in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        if (status === 404 || status === 410) {
          dead.push(s.id as string);
        } else {
          console.error('[push] send failed', status, err);
        }
      }
    }),
  );

  if (dead.length > 0) {
    await db.from('push_subscriptions').delete().in('id', dead);
  }
  return { sent, pruned: dead.length, skipped: false };
}
