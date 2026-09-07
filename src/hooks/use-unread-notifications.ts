"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to badge the Notifications nav entry.
 *
 * RLS on `notifications` scopes every read to `auth.uid() = user_id`.
 * Pass `accountId` so a user who belongs to more than one account
 * sees a badge that matches the (account-filtered) notifications page.
 *
 * Realtime keeps the count live; a refetch on tab focus / regained
 * visibility corrects any drift from events missed while the socket
 * was asleep.
 */
export function useUnreadNotifications(accountId?: string | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const refetch = async () => {
      let q = supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .is("read_at", null);
      if (accountId) q = q.eq("account_id", accountId);
      const { count: unread, error } = await q;
      if (!cancelled && !error) setCount(unread ?? 0);
    };

    void refetch();

    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    const inAccount = (row: Partial<Notification> | null | undefined) =>
      !accountId || row?.account_id === accountId;

    const channel = supabase
      .channel("notifications-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (!row.read_at && inAccount(row)) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as Notification;
            if (row.read_at && inAccount(row)) {
              setCount((n) => Math.max(0, n - 1));
            }
          } else if (payload.eventType === "DELETE") {
            const row = payload.old as Partial<Notification>;
            if (!row.read_at && inAccount(row)) {
              setCount((n) => Math.max(0, n - 1));
            }
          }
        },
      )
      .subscribe((status) => {
        // Rejoined after a drop — reconcile against the source of truth.
        if (status === "SUBSCRIBED") void refetch();
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [accountId]);

  return count;
}
