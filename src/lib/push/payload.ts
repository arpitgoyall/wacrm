/**
 * Pure notification-row → Web Push payload mapping. Kept free of any
 * Supabase / web-push imports so it's unit-testable and shared by the
 * dispatch route.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path the SW opens on click. */
  url: string;
  /** OS-notification collapse key. */
  tag: string;
  type: string;
  notificationId: string;
}

export interface NotificationRowForPush {
  id: string;
  type: string;
  title: string;
  body: string | null;
  conversation_id: string | null;
}

export function notificationToPushPayload(
  n: NotificationRowForPush,
): PushPayload {
  const url = n.conversation_id
    ? `/inbox?c=${encodeURIComponent(n.conversation_id)}`
    : '/notifications';
  // One OS notification per conversation (later alerts replace it);
  // system-level alerts with no conversation each stand alone.
  const tag = n.conversation_id
    ? `conversation-${n.conversation_id}`
    : `notification-${n.id}`;
  return {
    title: n.title || 'New notification',
    body: n.body ?? '',
    url,
    tag,
    type: n.type,
    notificationId: n.id,
  };
}
