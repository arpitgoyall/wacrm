"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Video,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { CHAT_MEDIA_ACCEPT } from "@/lib/storage/media-accept";
import type { QuickReply, QuickReplyKind, QuickReplyMediaType } from "@/types";

/** Bucket every non-template chat attachment uploads to (migration 023). */
const MEDIA_BUCKET = "chat-media";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
  media_url: string | null;
  media_type: QuickReplyMediaType | null;
  media_filename: string | null;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
    media_url: null,
    media_type: null,
    media_filename: null,
  };
}

export function QuickRepliesManager() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const mediaFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
      media_url: qr.media_url ?? null,
      media_type: qr.media_type ?? null,
      media_filename: qr.media_filename ?? null,
    });

  const removeMedia = () => {
    setDraft((d) => (d ? { ...d, media_url: null, media_type: null, media_filename: null } : d));
  };

  const handleMediaFile = useCallback(async (file: File) => {
    const kind: QuickReplyMediaType = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : "document";
    const allowed = CHAT_MEDIA_ACCEPT[kind].split(",");
    if (!allowed.includes(file.type)) {
      toast.error("That file type isn't supported for a quick-reply attachment.");
      return;
    }
    const max = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > max) {
      toast.error(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(max / 1024 / 1024)} MB.`,
      );
      return;
    }
    setUploadingMedia(true);
    try {
      const { publicUrl } = await uploadAccountMedia(MEDIA_BUCKET, file);
      setDraft((d) =>
        d
          ? { ...d, media_url: publicUrl, media_type: kind, media_filename: file.name }
          : d,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadingMedia(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error("Give the quick reply a name.");
      return;
    }
    const payload =
      draft.kind === "interactive"
        ? { title: draft.title, kind: "interactive", interactive_payload: draft.interactive_payload }
        : {
            title: draft.title,
            kind: "text",
            content_text: draft.content_text,
            media_url: draft.media_url,
            media_type: draft.media_type,
            media_filename: draft.media_filename,
          };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the quick reply.");
        return;
      }
      toast.success(draft.id ? "Quick reply updated." : "Quick reply created.");
      setDraft(null);
      await load();
    } catch {
      toast.error("Couldn't save the quick reply.");
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this quick reply?")) return;
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Couldn't delete the quick reply.");
        return;
      }
      await load();
    },
    [load],
  );

  return (
    <div>
      <SettingsPanelHead
        title="Quick replies"
        description="Reusable snippets — plain text or a saved interactive message — that agents can insert from the inbox composer."
        action={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            New quick reply
          </Button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No quick replies yet. Create one to reuse it across conversations.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qr.title}</p>
                <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  {qr.kind === "text" && qr.media_url && (
                    <MediaKindIcon kind={qr.media_type} className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">
                    {qr.kind === "interactive" && qr.interactive_payload
                      ? interactivePayloadPreviewText(qr.interactive_payload)
                      : qr.content_text ||
                        (qr.media_url ? "[attachment]" : "")}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(qr)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(qr.id)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit quick reply" : "New quick reply"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Name</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="e.g. Business hours"
                  className="bg-muted text-foreground"
                />
              </div>
              <div className="flex gap-2">
                <KindTab
                  active={draft.kind === "text"}
                  label="Text"
                  onClick={() => setDraft({ ...draft, kind: "text" })}
                />
                <KindTab
                  active={draft.kind === "interactive"}
                  label="Interactive"
                  onClick={() => setDraft({ ...draft, kind: "interactive" })}
                />
              </div>
              {draft.kind === "text" ? (
                <div className="space-y-2">
                  <Textarea
                    value={draft.content_text}
                    onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                    placeholder="The message text to insert"
                    className="min-h-28 bg-muted text-foreground"
                  />

                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Attachment (optional)
                    </label>
                    {draft.media_url ? (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
                        <MediaKindIcon kind={draft.media_type} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                          {draft.media_filename || draft.media_url}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={removeMedia}
                          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          ref={mediaFileRef}
                          type="file"
                          accept={Object.values(CHAT_MEDIA_ACCEPT).join(",")}
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleMediaFile(f);
                            e.target.value = "";
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={uploadingMedia}
                          onClick={() => mediaFileRef.current?.click()}
                        >
                          {uploadingMedia ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                          Attach image, video, or document
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <InteractiveBuilder
                  value={draft.interactive_payload}
                  onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KindTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
          : "flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}

/** Small icon matching a quick reply's attachment kind. */
function MediaKindIcon({
  kind,
  className,
}: {
  kind: QuickReplyMediaType | null | undefined;
  className?: string;
}) {
  if (kind === "image") return <ImageIcon className={className} />;
  if (kind === "video") return <Video className={className} />;
  return <FileText className={className} />;
}
