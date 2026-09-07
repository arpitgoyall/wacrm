"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
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

function viewingConversation(conversationId: string): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.pathname !== "/inbox") return false;
  return (
    new URLSearchParams(window.location.search).get("c") === conversationId
  );
}

/**
 * Ambient toast for a new customer message, unless it belongs to the
 * acting user (NotificationsClient owns those, with sound / push).
 * Module-scoped so the effect callback stays trivially memoizable.
 */
async function maybeAnnounce(
  message: NotificationMessage,
  userId: string | undefined,
  onOpen: (conversationId: string) => void,
): Promise<void> {
  if (userId) {
    const { data } = await createClient()
      .from("conversations")
      .select("assigned_agent_id")
      .eq("id", message.conversation_id)
      .maybeSingle();
    if (data?.assigned_agent_id === userId) return;
  }
  toast("New WhatsApp message", {
    description: messagePreview(message),
    action: {
      label: "Open",
      onClick: () => onOpen(message.conversation_id),
    },
    duration: 6000,
  });
}

/**
 * Ambient, in-app-only toast for new customer messages the acting user
 * is NOT responsible for — a lightweight signal that the shared queue
 * has activity.
 *
 * Messages on a conversation assigned to the acting user are left to
 * `NotificationsClient`, which owns the sound + web-push for anything
 * targeted at you (via the `new_message` notification row the webhook
 * writes). This split is the dedup: exactly one alert per message.
 */
export function InboundMessageNotifier() {
  const router = useRouter();
  const { user } = useAuth();
  const recentIdsRef = useRef<Set<string>>(new Set());

  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      if (event.eventType !== "INSERT") return;

      const message = event.new as NotificationMessage;
      if (
        message.sender_type !== "customer" ||
        recentIdsRef.current.has(message.id)
      ) {
        return;
      }

      recentIdsRef.current.add(message.id);
      if (recentIdsRef.current.size > 100) {
        const oldestId = recentIdsRef.current.values().next().value;
        if (oldestId) recentIdsRef.current.delete(oldestId);
      }

      // Already looking at the thread → nothing to announce.
      if (viewingConversation(message.conversation_id)) return;

      void maybeAnnounce(message, user?.id, (conversationId) =>
        router.push(`/inbox?c=${encodeURIComponent(conversationId)}`),
      );
    },
    [router, user?.id],
  );

  useRealtime({
    channelName: "inbound-message-notifications",
    onMessageEvent: handleMessageEvent,
    enabled: true,
  });

  return null;
}
