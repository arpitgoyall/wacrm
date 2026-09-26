"use client";

// ============================================================
// PipelineStageControl — inbox header replacement for the Status
// dropdown, shown to agents tagged "sales" or "support" whose team
// has a pipeline configured (see useAuth().isSalesAgent /
// isSupportAgent and account.sales_pipeline_id / support_pipeline_id).
//
// These agents care about where a contact sits in a sales/support
// pipeline, not the WhatsApp conversation's open/pending/closed
// bookkeeping — so this shows the contact's deal in the given pipeline
// (configured in Settings → Deals & currency) as a stage picker
// instead. If no deal exists yet for this contact in that pipeline, a
// "Create deal" affordance seeds one in the pipeline's first stage.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PipelineStage } from "@/types";

interface PipelineStageControlProps {
  contactId: string;
  contactLabel: string;
  accountId: string;
  /** Used to create a deal when none exists. Existing deals always use
   * their own pipeline. */
  pipelineId?: string | null;
  userId: string;
  /** Current user's `profiles.id` — deals created here auto-assign to
   *  their creator (deals.assigned_to is a FK to profiles.id). */
  assigneeProfileId?: string | null;
  defaultCurrency: string;
}

interface DealRow {
  id: string;
  stage_id: string;
  pipeline_id: string;
}

export function PipelineStageControl({
  contactId,
  contactLabel,
  accountId,
  pipelineId,
  userId,
  assigneeProfileId,
  defaultCurrency,
}: PipelineStageControlProps) {
  const t = useTranslations("Inbox.messageThread");
  const supabase = createClient();

  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deal, setDeal] = useState<DealRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: stageRows }, { data: dealRows }] = await Promise.all([
      supabase
        .from("pipeline_stages")
        .select("id, pipeline_id, name, position, color, created_at")
        .order("position", { ascending: true }),
      // Most recent still-open deal for this contact in this pipeline —
      // mirrors the same "open" filter used by the automation engine's
      // assign_deal step, so a stale won/lost deal never masks an
      // active one.
      supabase
        .from("deals")
        .select("id, stage_id, pipeline_id")
        .eq("account_id", accountId)
        .eq("contact_id", contactId)
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
  const visibleStages = deal
    ? stages.filter((stage) => stage.pipeline_id === deal.pipeline_id)
    : stages.filter((stage) => stage.pipeline_id === pipelineId);

  async function handleCreateDeal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const firstStage = visibleStages[0];
    const dealAmount = Number(amount);
    if (
      creating ||
      !firstStage ||
      !pipelineId ||
      amount.trim() === "" ||
      !Number.isFinite(dealAmount) ||
      dealAmount < 0
    ) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("deals")
      .insert({
        account_id: accountId,
        user_id: userId,
        pipeline_id: pipelineId,
        stage_id: firstStage.id,
        contact_id: contactId,
        title: contactLabel,
        value: dealAmount,
        currency: defaultCurrency,
        status: "open",
        // Auto-assign the new deal to whoever created it.
        assigned_to: assigneeProfileId ?? null,
      })
      .select("id, stage_id, pipeline_id")
      .single();
    setCreating(false);
    if (error || !data) {
      toast.error(t("dealCreateError"));
      return;
    }
    setDeal(data as DealRow);
    setCreateOpen(false);
    setAmount("");
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
      <>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={visibleStages.length === 0}
          title={visibleStages.length === 0 ? t("dealNoStagesHint") : undefined}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("createDeal")}
        </button>
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            if (creating) return;
            setCreateOpen(open);
            if (!open) setAmount("");
          }}
        >
          <DialogContent>
            <form onSubmit={handleCreateDeal}>
              <DialogHeader>
                <DialogTitle>{t("createDeal")}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-2 py-4">
                <Label htmlFor="inbox-deal-amount">
                  {t("dealAmount", { currency: defaultCurrency })}
                </Label>
                <Input
                  id="inbox-deal-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  autoFocus
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={creating}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false);
                    setAmount("");
                  }}
                  disabled={creating}
                >
                  {t("cancel")}
                </Button>
                <Button type="submit" disabled={creating || amount.trim() === ""}>
                  {creating ? t("creatingDeal") : t("createDeal")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={updating}
        className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        style={{ color: currentStage?.color }}
      >
        {currentStage?.name ?? t("dealStageUnknown")}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        {visibleStages.map((stage) => (
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
