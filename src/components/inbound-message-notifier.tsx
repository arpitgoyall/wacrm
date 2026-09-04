"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import type { Message } from "@/types";

interface NotificationMessage extends Message {
  sender_type: "customer" | "agent" | "bot";
}

function messagePreview(message: Message): string {
  if (message.content_text?.trim()) return message.content_text.trim();
  if (message.content_type === "image") return "Sent an image";
  if (message.content_type === "video") return "Sent a video";
  if (message.content_type === "audio") return "Sent a voice message";
  if (message.content_type === "document") return "Sent a document";
  if (message.content_type === "location") return "Shared a location";
  if (message.content_type === "interactive") return "Sent a reply";
  return "New WhatsApp message";
}

async function showPwaNotification(message: Message) {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification("New WhatsApp message", {
    body: messagePreview(message),
    icon: "/icon",
    badge: "/icon",
    tag: `conversation-${message.conversation_id}`,
    data: { url: `/inbox?c=${encodeURIComponent(message.conversation_id)}` },
  });
}

async function requestPwaNotificationPermission(message: Message) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  if (permission === "granted") await showPwaNotification(message);
}

export function InboundMessageNotifier() {
  const router = useRouter();
  const recentIdsRef = useRef<Set<string>>(new Set());

  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      if (event.eventType !== "INSERT") return;

      const message = event.new as NotificationMessage;
      if (message.sender_type !== "customer" || recentIdsRef.current.has(message.id)) {
        return;
      }

      recentIdsRef.current.add(message.id);
      if (recentIdsRef.current.size > 100) {
        const oldestId = recentIdsRef.current.values().next().value;
        if (oldestId) recentIdsRef.current.delete(oldestId);
      }

      const preview = messagePreview(message);
      const notificationsDisabled =
        typeof window === "undefined" ||
        !("Notification" in window) ||
        Notification.permission !== "granted";
      toast("New WhatsApp message", {
        description: preview,
        action: {
          label: notificationsDisabled ? "Enable notifications" : "Open",
          onClick: () => {
            if (notificationsDisabled) {
              void requestPwaNotificationPermission(message).catch(() => {});
              return;
            }
            router.push(`/inbox?c=${encodeURIComponent(message.conversation_id)}`);
          },
        },
        duration: 6000,
      });

      void showPwaNotification(message).catch(() => {
        // Browser notification support is optional; the in-app toast remains.
      });
    },
    [router],
  );

  useRealtime({
    channelName: "inbound-message-notifications",
    onMessageEvent: handleMessageEvent,
    enabled: true,
  });

  return null;
}
