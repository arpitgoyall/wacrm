'use client';

/**
 * Browser-side Web Push helpers: turn the VAPID public key into the
 * format `pushManager.subscribe` wants, drive the permission +
 * subscribe flow, and keep the server copy of the subscription fresh
 * (push endpoints rotate, so a granted device must re-register on
 * load).
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type EnablePushResult =
  | 'subscribed'
  | 'denied'
  | 'unsupported'
  | 'no-key'
  | 'error';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * iOS delivers Web Push only to a PWA that's been added to the Home
 * Screen (iOS 16.4+). In plain Safari the APIs exist but subscribe
 * throws, so callers show an "Add to Home Screen" hint instead.
 */
export function isIosSafariNotInstalled(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  if (!isIos) return false;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return !standalone;
}

export type PushStatus = 'unsupported' | 'blocked' | 'off' | 'on';

/** Current push state for this device. */
export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

function urlBase64ToApplicationServerKey(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buf;
}

async function registerOnServer(sub: PushSubscription): Promise<void> {
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...sub.toJSON(), user_agent: navigator.userAgent }),
  });
}

/** Prompt for permission (if needed) and register a subscription. */
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) return 'unsupported';
  if (!VAPID_PUBLIC_KEY) return 'no-key';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToApplicationServerKey(VAPID_PUBLIC_KEY),
      });
    }
    await registerOnServer(sub);
    return 'subscribed';
  } catch (err) {
    console.error('[push] enable failed', err);
    return 'error';
  }
}

/** Drop this device's subscription, client and server side. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  } catch (err) {
    console.error('[push] disable failed', err);
  }
}

/**
 * If permission is already granted, make sure the server holds this
 * device's current subscription. Cheap to call on every app load.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToApplicationServerKey(VAPID_PUBLIC_KEY),
      });
    }
    await registerOnServer(sub);
  } catch (err) {
    console.error('[push] sync failed', err);
  }
}
