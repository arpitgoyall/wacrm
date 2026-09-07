/**
 * Pure notification-row → Web Push payload mapping. Kept free of any
 * Supabase / web-push imports so it's unit-testable and shared by the
 * dispatch route.
 *
 * For `new_message` the shape mimics the WhatsApp app notification:
 * the chat name is the title, the message text is the body, and the
 * contact's avatar is the large icon. The service worker adds the
 * Reply / Mark-as-read action buttons based on `type` + `conversationId`.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Large icon (contact avatar for messages, app icon otherwise). */
  icon: string;
  /** In-app path the SW opens on click. */
  url: string;
  /** OS-notification collapse key. */
  tag: string;
  type: string;
  notificationId: string;
  /** Present for message alerts — enables the inline Reply action. */
  conversationId: string | null;
}

export interface NotificationRowForPush {
  id: string;
  type: string;
  title: string;
  body: string | null;
  conversation_id: string | null;
}

export interface ContactForPush {
  name: string | null;
  avatar_url: string | null;
}

const APP_ICON = '/icon-192.png';

export function notificationToPushPayload(
  n: NotificationRowForPush,
  contact?: ContactForPush | null,
): PushPayload {
  const url = n.conversation_id
    ? `/inbox?c=${encodeURIComponent(n.conversation_id)}`
    : '/notifications';
  // One OS notification per conversation (later alerts replace it);
  // system-level alerts with no conversation each stand alone.
  const tag = n.conversation_id
    ? `conversation-${n.conversation_id}`
    : `notification-${n.id}`;

  // A message alert reads like WhatsApp: chat name on top, text below,
  // avatar as the icon. Everything else keeps the row's own copy.
  const isMessage = n.type === 'new_message';
  const contactName = contact?.name?.trim();
  const title =
    (isMessage && contactName) || n.title || 'New notification';
  const icon =
    (isMessage && contact?.avatar_url) || APP_ICON;

  return {
    title,
    body: n.body ?? '',
    icon,
    url,
    tag,
    type: n.type,
    notificationId: n.id,
    conversationId: n.conversation_id,
  };
}
