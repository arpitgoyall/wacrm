"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, PhoneOutgoing, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

interface CallAttemptsCounterProps {
  dealId: string;
  initial: number;
  /** Read-only (drag overlay, bulk-select mode). */
  readOnly?: boolean;
}

/** Stops the tap from opening the deal, toggling selection or starting a drag. */
function swallow(e: React.SyntheticEvent) {
  e.stopPropagation();
}

export function CallAttemptsCounter({
  dealId,
  initial,
  readOnly,
}: CallAttemptsCounterProps) {
  const t = useTranslations("Pipelines.card");
  const [count, setCount] = useState(initial);
  const pending = useRef(0);

  // Pick up fresh values from a board reload, but never mid-update.
  useEffect(() => {
    if (pending.current === 0) setCount(initial);
  }, [initial]);

  async function adjust(delta: 1 | -1) {
    if (readOnly) return;
    if (delta < 0 && count <= 0) return;
    setCount((c) => Math.max(0, c + delta));
    pending.current += 1;
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("adjust_deal_call_attempts", {
        p_deal_id: dealId,
        p_delta: delta,
      });
      if (error || typeof data !== "number") throw error ?? new Error("no row");
      pending.current -= 1;
      // The server value wins once every in-flight tap has landed.
      if (pending.current === 0) setCount(data);
    } catch {
      pending.current -= 1;
      setCount((c) => Math.max(0, c - delta));
      toast.error(t("callAttemptsError"));
    }
  }

  const buttonClass =
    "inline-flex h-6 w-6 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none";

  return (
    <div
      className="flex items-center gap-1.5"
      onClick={swallow}
      onPointerDown={swallow}
      onKeyDown={swallow}
      title={t("callAttempts")}
    >
      <PhoneOutgoing className="text-muted-foreground h-3 w-3" aria-hidden />
      <span className="text-muted-foreground text-[11px]">
        {t("callAttempts")}
      </span>
      {!readOnly && (
        <button
          type="button"
          aria-label={t("callAttemptsDecrease")}
          disabled={count <= 0}
          onClick={() => adjust(-1)}
          className={buttonClass}
        >
          <Minus className="h-3 w-3" />
        </button>
      )}
      <span
        aria-live="polite"
        className="text-foreground min-w-[1.25rem] text-center text-xs font-semibold tabular-nums"
      >
        {count}
      </span>
      {!readOnly && (
        <button
          type="button"
          aria-label={t("callAttemptsIncrease")}
          onClick={() => adjust(1)}
          className={buttonClass}
        >
          <Plus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
