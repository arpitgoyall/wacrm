"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, GitBranch, Loader2, type LucideIcon } from "lucide-react";

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

// Select can't carry a `null` option value, so "no pipeline configured"
// uses this sentinel and gets mapped back to `null` before the write.
const PIPELINE_UNSET = "__unset__";

interface PipelineOption {
  id: string;
  name: string;
}

/**
 * One admin-configurable "which pipeline does this team see in the
 * inbox instead of conversation status" setting. Shared by the sales
 * and support cards below — identical shape, different account column
 * and copy.
 */
function PipelineSettingCard({
  icon: Icon,
  title,
  description,
  label,
  noneLabel,
  noPipelinesHint,
  adminOnlyHint,
  saveLabel,
  savingLabel,
  pipelines,
  value,
  onChange,
  onSave,
  dirty,
  saving,
  canEditSettings,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  label: string;
  noneLabel: string;
  noPipelinesHint: string;
  adminOnlyHint: string;
  saveLabel: string;
  savingLabel: string;
  pipelines: PipelineOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  canEditSettings: boolean;
  disabled: boolean;
}) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Icon className="size-4 text-primary" />
          {title}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:max-w-xs">
          <Label className="text-muted-foreground">{label}</Label>
          <select
            value={value ?? PIPELINE_UNSET}
            onChange={(e) =>
              onChange(e.target.value === PIPELINE_UNSET ? null : e.target.value)
            }
            disabled={!canEditSettings || disabled}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value={PIPELINE_UNSET}>{noneLabel}</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">{adminOnlyHint}</p>
          )}
          {canEditSettings && pipelines.length === 0 && (
            <p className="text-xs text-muted-foreground">{noPipelinesHint}</p>
          )}
        </div>

        {canEditSettings && (
          <Button
            onClick={onSave}
            disabled={saving || !dirty}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {savingLabel}
              </>
            ) : (
              saveLabel
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Deals settings — account-wide default currency, plus the sales and
 * support pipelines that tagged agents see in the inbox instead of
 * conversation status.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight to `accounts.default_currency`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control. The two
 * pipeline pickers (migrations 048/049) share that same admin-only gate.
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

  const [selectedSalesPipeline, setSelectedSalesPipeline] = useState<string | null>(
    account?.sales_pipeline_id ?? null,
  );
  const [savingSalesPipeline, setSavingSalesPipeline] = useState(false);

  const [selectedSupportPipeline, setSelectedSupportPipeline] = useState<string | null>(
    account?.support_pipeline_id ?? null,
  );
  const [savingSupportPipeline, setSavingSupportPipeline] = useState(false);

  const fetchPipelines = useCallback(async () => {
    const { data } = await supabase.from("pipelines").select("id, name").order("name");
    setPipelines((data as PipelineOption[] | null) ?? []);
  }, [supabase]);

  useEffect(() => {
    void fetchPipelines();
  }, [fetchPipelines]);

  // Keep the selects in sync once the profile (and its account fields)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  useEffect(() => {
    setSelectedSalesPipeline(account?.sales_pipeline_id ?? null);
  }, [account?.sales_pipeline_id]);

  useEffect(() => {
    setSelectedSupportPipeline(account?.support_pipeline_id ?? null);
  }, [account?.support_pipeline_id]);

  const dirty = selected !== defaultCurrency;
  const salesPipelineDirty = selectedSalesPipeline !== (account?.sales_pipeline_id ?? null);
  const supportPipelineDirty =
    selectedSupportPipeline !== (account?.support_pipeline_id ?? null);

  async function handleSaveSalesPipeline() {
    if (!accountId || !salesPipelineDirty) return;
    setSavingSalesPipeline(true);
    const { error } = await supabase
      .from("accounts")
      .update({ sales_pipeline_id: selectedSalesPipeline })
      .eq("id", accountId);
    if (error) {
      toast.error(t("salesPipelineSaveFailed"));
      setSavingSalesPipeline(false);
      return;
    }
    await refreshProfile();
    setSavingSalesPipeline(false);
    toast.success(t("salesPipelineSaveSuccess"));
  }

  async function handleSaveSupportPipeline() {
    if (!accountId || !supportPipelineDirty) return;
    setSavingSupportPipeline(true);
    const { error } = await supabase
      .from("accounts")
      .update({ support_pipeline_id: selectedSupportPipeline })
      .eq("id", accountId);
    if (error) {
      toast.error(t("supportPipelineSaveFailed"));
      setSavingSupportPipeline(false);
      return;
    }
    await refreshProfile();
    setSavingSupportPipeline(false);
    toast.success(t("supportPipelineSaveSuccess"));
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

      <PipelineSettingCard
        icon={GitBranch}
        title={t("salesPipelineTitle")}
        description={t("salesPipelineDesc")}
        label={t("salesPipelineLabel")}
        noneLabel={t("salesPipelineNone")}
        noPipelinesHint={t("salesPipelineNoPipelines")}
        adminOnlyHint={t("adminOnlyHint")}
        saveLabel={t("save")}
        savingLabel={t("saving")}
        pipelines={pipelines}
        value={selectedSalesPipeline}
        onChange={setSelectedSalesPipeline}
        onSave={handleSaveSalesPipeline}
        dirty={salesPipelineDirty}
        saving={savingSalesPipeline}
        canEditSettings={canEditSettings}
        disabled={profileLoading}
      />

      <PipelineSettingCard
        icon={GitBranch}
        title={t("supportPipelineTitle")}
        description={t("supportPipelineDesc")}
        label={t("supportPipelineLabel")}
        noneLabel={t("supportPipelineNone")}
        noPipelinesHint={t("salesPipelineNoPipelines")}
        adminOnlyHint={t("adminOnlyHint")}
        saveLabel={t("save")}
        savingLabel={t("saving")}
        pipelines={pipelines}
        value={selectedSupportPipeline}
        onChange={setSelectedSupportPipeline}
        onSave={handleSaveSupportPipeline}
        dirty={supportPipelineDirty}
        saving={savingSupportPipeline}
        canEditSettings={canEditSettings}
        disabled={profileLoading}
      />
    </section>
  );
}
