"use client";

// ============================================================
// SalesPipelineControl — inbox header replacement for the Status
// dropdown, shown only to agents tagged "sales" (see useAuth().isSalesAgent).
//
// Sales agents care about where a contact sits in the sales pipeline,
// not the WhatsApp conversation's open/pending/closed bookkeeping — so
// this shows the contact's deal in the account's configured sales
// pipeline (Settings → Deals & currency) as a stage picker instead.
// If no deal exists yet for this contact in that pipeline, a
// "Create deal" affordance seeds one in the pipeline's first stage.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PipelineStage } from "@/types";

interface SalesPipelineControlProps {
  contactId: string;
  contactLabel: string;
  accountId: string;
  pipelineId: string;
  userId: string;
  defaultCurrency: string;
}

interface DealRow {
  id: string;
  stage_id: string;
}

export function SalesPipelineControl({
  contactId,
  contactLabel,
  accountId,
  pipelineId,
  userId,
  defaultCurrency,
}: SalesPipelineControlProps) {
  const t = useTranslations("Inbox.messageThread");
  const supabase = createClient();

  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deal, setDeal] = useState<DealRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: stageRows }, { data: dealRows }] = await Promise.all([
      supabase
        .from("pipeline_stages")
        .select("id, pipeline_id, name, position, color, created_at")
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true }),
      // Most recent still-open deal for this contact in the sales
      // pipeline — mirrors the same "open" filter used by the
      // automation engine's assign_deal step, so a stale won/lost deal
      // never masks an active one.
      supabase
        .from("deals")
        .select("id, stage_id")
        .eq("account_id", accountId)
        .eq("contact_id", contactId)
        .eq("pipeline_id", pipelineId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    setStages((stageRows as PipelineStage[] | null) ?? []);
    setDeal((dealRows?.[0] as DealRow | undefined) ?? null);
    setLoading(false);
  }, [supabase, pipelineId, accountId, contactId]);

  // setStages/setDeal/setLoading run inside async Supabase callback
  // completion, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const currentStage = stages.find((s) => s.id === deal?.stage_id) ?? null;

  async function handleCreateDeal() {
    if (creating || stages.length === 0) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("deals")
      .insert({
        account_id: accountId,
        user_id: userId,
        pipeline_id: pipelineId,
        stage_id: stages[0].id,
        contact_id: contactId,
        title: contactLabel,
        value: 0,
        currency: defaultCurrency,
        status: "open",
      })
      .select("id, stage_id")
      .single();
    setCreating(false);
    if (error || !data) {
      toast.error(t("dealCreateError"));
      return;
    }
    setDeal(data as DealRow);
  }

  async function handleStageChange(stageId: string) {
    if (!deal || updating || stageId === deal.stage_id) return;
    const previous = deal;
    setUpdating(true);
    setDeal({ ...deal, stage_id: stageId });
    const { error } = await supabase
      .from("deals")
      .update({ stage_id: stageId })
      .eq("id", deal.id);
    setUpdating(false);
    if (error) {
      setDeal(previous);
      toast.error(t("dealStageUpdateError"));
    }
  }

  if (loading) {
    return (
      <span className="inline-flex h-7 items-center px-2 text-xs text-muted-foreground">
        {t("dealStageLoading")}
      </span>
    );
  }

  if (!deal) {
    return (
      <button
        type="button"
        onClick={handleCreateDeal}
        disabled={creating || stages.length === 0}
        title={stages.length === 0 ? t("dealNoStagesHint") : undefined}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {creating ? t("creatingDeal") : t("createDeal")}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={updating}
        className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {currentStage?.name ?? t("dealStageUnknown")}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        {stages.map((stage) => (
          <DropdownMenuItem
            key={stage.id}
            onClick={() => handleStageChange(stage.id)}
            className={cn(
              "text-sm",
              stage.id === deal.stage_id ? "text-primary" : "text-popover-foreground",
            )}
          >
            {stage.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
