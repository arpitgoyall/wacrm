/**
 * In-tab signal that a deal was created or changed stage.
 *
 * The inbox list shows each contact's pipeline stage. Changing the stage
 * from the conversation header must update that badge immediately, even
 * when the Supabase realtime feed for `deals` is slow or unavailable.
 */

const EVENT = 'wacrm:deals-changed';

export function notifyDealsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EVENT));
}

/** Subscribes to deal changes; returns the unsubscribe function. */
export function onDealsChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
