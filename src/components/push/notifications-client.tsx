'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import type { Notification } from '@/types';
import {
  enablePush,
  isIosSafariNotInstalled,
  pushSupported,
  syncPushSubscription,
} from '@/lib/push/client';
import { playNotifyTone, unlockNotifySound } from '@/lib/notify/sound';

const PROMPT_DISMISS_KEY = 'wacrm.push-prompt-dismissed';

/** True when the inbox is open on exactly this conversation. */
function viewingConversation(conversationId: string | null | undefined): boolean {
  if (!conversationId || typeof window === 'undefined') return false;
  if (window.location.pathname !== '/inbox') return false;
  return (
    new URLSearchParams(window.location.search).get('c') === conversationId
  );
}

/**
 * Headless. Runs inside the dashboard shell and:
 *   - primes the notification chime on the first user gesture,
 *   - keeps this device's push subscription registered server-side,
 *   - offers a one-time "enable notifications" prompt,
 *   - on a new `notifications` row for this user, plays the chime and
 *     shows an in-app toast while the tab is visible (the OS
 *     notification from the service worker covers the tab-hidden case).
 */
export function NotificationsClient() {
  const router = useRouter();
  const seen = useRef<Set<string>>(new Set());

  // Unlock Web Audio on the first interaction anywhere in the app.
  useEffect(() => {
    const onGesture = () => unlockNotifySound();
    window.addEventListener('pointerdown', onGesture, { once: true });
    window.addEventListener('keydown', onGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, []);

  // Keep the server's copy of this device's subscription fresh, and
  // nudge once for permission if we've never asked.
  useEffect(() => {
    if (!pushSupported()) return;
    void syncPushSubscription();

    if (Notification.permission !== 'default') return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(PROMPT_DISMISS_KEY) === '1';
    } catch {
      // storage blocked — treat as not dismissed
    }
    if (dismissed) return;

    const remember = () => {
      try {
        localStorage.setItem(PROMPT_DISMISS_KEY, '1');
      } catch {
        /* ignore */
      }
    };

    const timer = window.setTimeout(() => {
      if (isIosSafariNotInstalled()) {
        toast('Get notified on your phone', {
          description:
            'Add this app to your Home Screen, then reopen it to turn on notifications.',
          duration: 12000,
          onDismiss: remember,
          onAutoClose: remember,
        });
        return;
      }
      toast('Turn on notifications', {
        description: 'Get pinged when a chat is assigned to you or a customer replies.',
        duration: 15000,
        action: {
          label: 'Enable',
          onClick: async () => {
            remember();
            const res = await enablePush();
            if (res === 'subscribed') {
              toast.success('Notifications on.');
            } else if (res === 'denied') {
              toast.error(
                'Notifications blocked — enable them in your browser settings.',
              );
            } else if (res !== 'unsupported') {
              toast.error("Couldn't enable notifications.");
            }
          },
        },
        onDismiss: remember,
        onAutoClose: remember,
      });
    }, 4000);

    return () => window.clearTimeout(timer);
  }, []);

  // Live in-app alerts. RLS scopes the stream to this user's rows.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('notifications-client')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          const row = payload.new as Notification;
          if (!row?.id || seen.current.has(row.id)) return;
          seen.current.add(row.id);
          if (seen.current.size > 200) {
            const oldest = seen.current.values().next().value;
            if (oldest) seen.current.delete(oldest);
          }

          if (document.visibilityState !== 'visible') return;
          // Already reading this thread — no toast, no chime.
          if (viewingConversation(row.conversation_id)) return;

          playNotifyTone();
          toast(row.title, {
            description: row.body ?? undefined,
            action: row.conversation_id
              ? {
                  label: 'Open',
                  onClick: () =>
                    router.push(`/inbox?c=${row.conversation_id}`),
                }
              : undefined,
            duration: 6000,
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
