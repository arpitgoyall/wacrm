"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, GitBranch, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

// Select can't carry a `null` option value, so "no sales pipeline" uses
// this sentinel and gets mapped back to `null` before the write.
const SALES_PIPELINE_UNSET = "__unset__";

interface PipelineOption {
  id: string;
  name: string;
}

/**
 * Deals settings — account-wide default currency.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight to `accounts.default_currency`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control.
 */
export function DealsSettings() {
  const supabase = createClient();
  const {
    accountId,
    account,
    defaultCurrency,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);
  const t = useTranslations("Settings.deals");

  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(
    account?.sales_pipeline_id ?? null,
  );
  const [savingPipeline, setSavingPipeline] = useState(false);

  const fetchPipelines = useCallback(async () => {
    const { data } = await supabase.from("pipelines").select("id, name").order("name");
    setPipelines((data as PipelineOption[] | null) ?? []);
  }, [supabase]);

  useEffect(() => {
    void fetchPipelines();
  }, [fetchPipelines]);

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  useEffect(() => {
    setSelectedPipeline(account?.sales_pipeline_id ?? null);
  }, [account?.sales_pipeline_id]);

  const dirty = selected !== defaultCurrency;
  const pipelineDirty = selectedPipeline !== (account?.sales_pipeline_id ?? null);

  async function handleSavePipeline() {
    if (!accountId || !pipelineDirty) return;
    setSavingPipeline(true);
    const { error } = await supabase
      .from("accounts")
      .update({ sales_pipeline_id: selectedPipeline })
      .eq("id", accountId);
    if (error) {
      toast.error(t("salesPipelineSaveFailed"));
      setSavingPipeline(false);
      return;
    }
    await refreshProfile();
    setSavingPipeline(false);
    toast.success(t("salesPipelineSaveSuccess"));
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ default_currency: selected })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Coins className="size-4 text-primary" />
            {t("defaultCurrency")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("defaultCurrencyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("currencyLabel")}</Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <GitBranch className="size-4 text-primary" />
            {t("salesPipelineTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("salesPipelineDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("salesPipelineLabel")}</Label>
            <select
              value={selectedPipeline ?? SALES_PIPELINE_UNSET}
              onChange={(e) =>
                setSelectedPipeline(
                  e.target.value === SALES_PIPELINE_UNSET ? null : e.target.value,
                )
              }
              disabled={!canEditSettings || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value={SALES_PIPELINE_UNSET}>{t("salesPipelineNone")}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
            {canEditSettings && pipelines.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("salesPipelineNoPipelines")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSavePipeline}
              disabled={savingPipeline || !pipelineDirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingPipeline ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
