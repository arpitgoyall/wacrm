"use client";

import { FileText, List, Reply, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free (plain
 * English) so it can be dropped into the composer, the automation
 * builder, and the quick-replies manager without namespace coupling.
 */
export function InteractivePreview({
  payload,
  className,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
        className,
      )}
    >
      {payload.header_type === "image" && payload.header_media_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={payload.header_media_url}
          alt="Header preview"
          className="h-32 w-full object-cover"
        />
      )}
      {payload.header_type === "video" && payload.header_media_url && (
        <div className="flex h-32 w-full items-center justify-center bg-muted text-muted-foreground">
          <Video className="h-8 w-8" />
        </div>
      )}
      {payload.header_type === "document" && payload.header_media_url && (
        <div className="flex h-16 w-full items-center gap-2 bg-muted px-3 text-muted-foreground">
          <FileText className="h-5 w-5 shrink-0" />
          <span className="truncate text-xs">Document attached</span>
        </div>
      )}

      <div className="px-3 py-2">
        {!payload.header_type && payload.header ? (
          <p className="mb-1 break-words text-sm font-semibold">
            {payload.header}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm">
          {payload.body || (
            <span className="text-muted-foreground">Message body…</span>
          )}
        </p>
        {payload.footer ? (
          <p className="mt-1 break-words text-[11px] text-muted-foreground">
            {payload.footer}
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col border-t border-border">
          {payload.buttons.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              disabled
              className="flex items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary first:border-t-0"
            >
              <Reply className="h-3.5 w-3.5" />
              <span className="truncate">{b.title || "Button"}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary"
        >
          <List className="h-3.5 w-3.5" />
          <span className="truncate">{payload.button_label || "Menu"}</span>
        </button>
      )}
    </div>
  );
}
