"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
  FileText,
  Download,
  ExternalLink,
  Phone,
  Copy,
  Reply,
  Search,
} from "lucide-react";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";
import { useTranslations } from "next-intl";

export interface TemplateSendValues {
  body: string[];
  headerText?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

function InboxTemplatePreview({
  template,
  bodyValues,
  headerValue,
}: {
  template: MessageTemplate;
  bodyValues?: string[];
  headerValue?: string;
}) {
  const values = bodyValues ?? template.sample_values?.body ?? [];
  const body = renderBodyPreview(template.body_text, values);
  const header = renderBodyPreview(
    template.header_content ?? "",
    headerValue ? [headerValue] : template.sample_values?.header ?? [],
  );
  const storedUrl = template.header_media_url?.trim();
  const handleUrl = template.header_handle?.trim();
  const mediaUrl =
    storedUrl || (handleUrl && /^https?:\/\//i.test(handleUrl) ? handleUrl : undefined);

  return (
    <div className="flex justify-end rounded-lg border border-[#d8d2c8] bg-[#efeae2] p-2">
      <div className="w-full max-w-sm overflow-hidden rounded-lg bg-[#d9fdd3] text-[#111b21] shadow-sm">
        {template.header_type === "image" &&
          (mediaUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl}
              alt={`${template.name} header`}
              loading="lazy"
              className="max-h-52 w-full bg-[#d9e0e3] object-cover"
            />
          ) : (
            <div className="flex h-24 items-center justify-center bg-[#d9e0e3]">
              <FileText className="size-7 text-[#667781]" />
            </div>
          ))}
        {template.header_type === "video" &&
          (mediaUrl ? (
            <video className="max-h-52 w-full bg-black" controls preload="metadata">
              <source src={mediaUrl} />
            </video>
          ) : (
            <div className="flex h-24 items-center justify-center bg-[#202c33] text-xs text-white/80">
              Video preview
            </div>
          ))}
        {template.header_type === "document" && (
          <div className="m-2 flex items-center gap-2 rounded-md bg-white/60 p-2">
            <span className="flex size-9 items-center justify-center rounded bg-[#e65b65] text-white">
              <FileText className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {template.header_content || `${template.name}.pdf`}
            </span>
            {mediaUrl && <Download className="size-4 text-[#667781]" />}
          </div>
        )}
        <div className="space-y-1 px-3 py-2.5">
          {template.header_type === "text" && header && (
            <p className="text-sm font-semibold">{header}</p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>
          {template.footer_text && (
            <p className="text-[11px] text-[#667781]">{template.footer_text}</p>
          )}
          <p className="text-right text-[10px] text-[#667781]">12:00</p>
        </div>
        {!!template.buttons?.length && (
          <div className="divide-y divide-[#cfd8d3] border-t border-[#cfd8d3]">
            {template.buttons.map((button, index) => {
              const Icon =
                button.type === "URL"
                  ? ExternalLink
                  : button.type === "PHONE_NUMBER"
                    ? Phone
                    : button.type === "COPY_CODE"
                      ? Copy
                      : Reply;
              return (
                <div
                  key={`${button.type}-${index}`}
                  className="flex items-center justify-center gap-2 py-2 text-xs font-medium text-[#008069]"
                >
                  <Icon className="size-3.5" />
                  {button.text}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

/**
 * Templates may need values for: body variables, a text-header
 * variable, and per-URL-button suffixes. Collect them all so the
 * send-message path doesn't 400 on missing parameters.
 */
function collectVariableSlots(template: MessageTemplate): {
  bodyVars: number[];
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
} {
  const bodyVars = extractVariableIndices(template.body_text);
  const headerVarCount =
    template.header_type === "text" && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === "URL" && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVarCount, urlButtonSlots };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const t = useTranslations("Inbox.templatePicker");

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerText, setHeaderText] = useState<string>("");
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Scope by RLS (message_templates_select → is_account_member), NOT by
      // user_id. Templates are account-owned, so filtering on the caller's
      // user_id hid templates that a teammate created — leaving them unable
      // to send approved templates in a shared account.
      const { data, error } = await supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setParams([]);
    setHeaderText("");
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      resetSelection();
      setSearch("");
    }
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectVariableSlots(template);
    setSelected(template);
    setParams(new Array(slots.bodyVars.length).fill(""));
    setHeaderText("");
    setButtonParams({});
  }

  function confirm() {
    if (!selected) return;
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()]),
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected],
  );
  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return templates;
    return templates.filter((template) => {
      const title =
        template.header_type === "text" ? template.header_content ?? "" : "";
      return [template.name, title].some((value) =>
        value.toLocaleLowerCase().includes(query),
      );
    });
  }, [search, templates]);
  const canConfirm =
    !!selected &&
    !!slots &&
    slots.bodyVars.every((_, i) => (params[i] ?? "").trim().length > 0) &&
    (slots.headerVarCount === 0 || headerText.trim().length > 0) &&
    slots.urlButtonSlots.every(
      (s) => (buttonParams[s.index] ?? "").trim().length > 0,
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : t("sendTemplate")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? t("fillPlaceholders")
              : t("pickTemplate")}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchPlaceholder")}
                className="border-border bg-muted pl-9 text-foreground placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
            <div className="max-h-[52vh] space-y-2 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : templates.length === 0 ? (
                <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                  <p className="text-sm text-popover-foreground">
                    {t("noApprovedTemplates")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("noApprovedTemplatesHint")}
                  </p>
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="rounded-md border border-border bg-background/50 p-6 text-center text-sm text-muted-foreground">
                  {t("noSearchResults")}
                </div>
              ) : (
                filteredTemplates.map((template) => {
                  const title =
                    template.header_type === "text"
                      ? template.header_content?.trim()
                      : "";
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => pickTemplate(template)}
                      className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                    >
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium text-popover-foreground">
                              {template.name}
                            </p>
                            <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                              {template.category}
                            </Badge>
                            {template.language && (
                              <span className="text-[10px] uppercase text-muted-foreground">
                                {template.language}
                              </span>
                            )}
                          </div>
                          {title && (
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {title}
                            </p>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t("preview")}</p>
              <InboxTemplatePreview
                template={selected}
                bodyValues={params}
                headerValue={headerText}
              />
            </div>
            {slots && slots.headerVarCount > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {`Header {{1}}`}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t("headerValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}
            {slots?.bodyVars.map((v, i) => (
              <div key={v} className="space-y-1">
                <Label className="text-xs text-popover-foreground">{`Body {{${v}}}`}</Label>
                <Input
                  value={params[i] ?? ""}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  placeholder={t("bodyValuePlaceholder", { val: `{{${v}}}` })}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
            {slots?.urlButtonSlots.map((slot) => (
              <div key={slot.index} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {`URL button "${slot.text}" — value for `}{`{{1}}`}
                </Label>
                <Input
                  value={buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    setButtonParams((prev) => ({
                      ...prev,
                      [slot.index]: e.target.value,
                    }))
                  }
                  placeholder={t("urlSuffixValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground break-all">
                  {t("finalUrl", { url: slot.url.replace(/\{\{1\}\}/g, buttonParams[slot.index] || "{{1}}") })}
                </p>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t("send")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
