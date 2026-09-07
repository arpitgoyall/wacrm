"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, BellRing, Clock, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  disablePush,
  enablePush,
  pushStatus,
  type PushStatus,
} from "@/lib/push/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Notification settings.
 *
 *   - This device: turn Web Push on/off (any role).
 *   - Reply-time SLA: minutes before an unanswered assigned chat pings
 *     the agent — account-wide, admin-only (writes
 *     `accounts.sla_response_minutes`, gated by the `accounts_update`
 *     RLS policy the same way currency / pipelines are).
 */
export function NotificationsSettings() {
  const supabase = createClient();
  const { accountId, account, canEditSettings, profileLoading, refreshProfile } =
    useAuth();
  const t = useTranslations("Settings.notifications");

  const [status, setStatus] = useState<PushStatus>("off");
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(() => {
    void pushStatus().then(setStatus);
  }, []);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const toggle = async () => {
    setBusy(true);
    try {
      if (status === "on") {
        await disablePush();
        toast.success(t("pushDisabled"));
      } else {
        const res = await enablePush();
        if (res === "subscribed") toast.success(t("pushEnabled"));
        else if (res === "denied") toast.error(t("pushBlocked"));
        else if (res === "no-key") toast.error(t("pushNotConfigured"));
        else if (res !== "unsupported") toast.error(t("pushError"));
      }
    } finally {
      refreshStatus();
      setBusy(false);
    }
  };

  // ---- SLA ----
  const storedSla = account?.sla_response_minutes ?? 0;
  const [slaOn, setSlaOn] = useState(storedSla > 0);
  const [slaMinutes, setSlaMinutes] = useState(storedSla > 0 ? storedSla : 15);
  const [savingSla, setSavingSla] = useState(false);

  useEffect(() => {
    const v = account?.sla_response_minutes ?? 0;
    setSlaOn(v > 0);
    if (v > 0) setSlaMinutes(v);
  }, [account?.sla_response_minutes]);

  const nextSla = slaOn ? Math.max(1, Math.floor(slaMinutes) || 0) : 0;
  const slaDirty = nextSla !== storedSla;

  const saveSla = async () => {
    if (!accountId || !slaDirty) return;
    setSavingSla(true);
    const { error } = await supabase
      .from("accounts")
      .update({ sla_response_minutes: nextSla || null })
      .eq("id", accountId);
    if (error) {
      toast.error(t("slaSaveFailed"));
      setSavingSla(false);
      return;
    }
    await refreshProfile();
    setSavingSla(false);
    toast.success(t("slaSaveSuccess"));
  };

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <BellRing className="size-4 text-primary" />
            {t("deviceTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("deviceDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status === "unsupported" ? (
            <p className="text-sm text-muted-foreground">
              {t("pushUnsupported")}
            </p>
          ) : status === "blocked" ? (
            <p className="text-sm text-muted-foreground">{t("pushBlockedHint")}</p>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                onClick={toggle}
                disabled={busy}
                variant={status === "on" ? "outline" : "default"}
                className={
                  status === "on"
                    ? ""
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Bell className="size-4" />
                )}
                {status === "on" ? t("turnOff") : t("turnOn")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {status === "on" ? t("statusOn") : t("statusOff")}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Clock className="size-4 text-primary" />
            {t("slaTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("slaDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={slaOn}
              disabled={!canEditSettings || profileLoading}
              onChange={(e) => setSlaOn(e.target.checked)}
              className="size-4 rounded border-border bg-muted"
            />
            {t("slaEnable")}
          </label>

          {slaOn && (
            <div className="grid gap-2 sm:max-w-[160px]">
              <Label className="text-muted-foreground">{t("slaMinutes")}</Label>
              <Input
                type="number"
                min={1}
                value={slaMinutes}
                disabled={!canEditSettings || profileLoading}
                onChange={(e) => setSlaMinutes(Number(e.target.value))}
                className="bg-muted"
              />
            </div>
          )}

          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
          )}

          {canEditSettings && (
            <Button
              onClick={saveSla}
              disabled={savingSla || !slaDirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingSla ? (
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
