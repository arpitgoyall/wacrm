'use client';

import { Rocket } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

export interface ProactiveState {
  outreachEnabled: boolean;
  outreachTemplateName: string;
  outreachDelayMinutes: number;
  followupEnabled: boolean;
  followupTemplateName: string;
  followupFirstDelayHours: number;
  followupIntervalHours: number;
  followupMaxAttempts: number;
  templateLanguage: string;
  dailyCap: number;
}

export const DEFAULT_PROACTIVE: ProactiveState = {
  outreachEnabled: false,
  outreachTemplateName: '',
  outreachDelayMinutes: 5,
  followupEnabled: false,
  followupTemplateName: '',
  followupFirstDelayHours: 4,
  followupIntervalHours: 24,
  followupMaxAttempts: 3,
  templateLanguage: 'en',
  dailyCap: 100,
};

/** Map the API's snake_case config onto form state. */
export function proactiveFromApi(data: Record<string, unknown>): ProactiveState {
  const d = DEFAULT_PROACTIVE;
  return {
    outreachEnabled: data.outreach_enabled === true,
    outreachTemplateName: (data.outreach_template_name as string) ?? '',
    outreachDelayMinutes: Number(data.outreach_delay_minutes) || d.outreachDelayMinutes,
    followupEnabled: data.followup_enabled === true,
    followupTemplateName: (data.followup_template_name as string) ?? '',
    followupFirstDelayHours:
      Number(data.followup_first_delay_hours) || d.followupFirstDelayHours,
    followupIntervalHours:
      Number(data.followup_interval_hours) || d.followupIntervalHours,
    followupMaxAttempts: Number(data.followup_max_attempts) || d.followupMaxAttempts,
    templateLanguage: (data.proactive_template_language as string) || d.templateLanguage,
    dailyCap: Number(data.proactive_daily_cap) || d.dailyCap,
  };
}

/** Map form state onto the API's snake_case body. */
export function proactiveToApi(s: ProactiveState) {
  return {
    outreach_enabled: s.outreachEnabled,
    outreach_template_name: s.outreachTemplateName.trim() || null,
    outreach_delay_minutes: s.outreachDelayMinutes,
    followup_enabled: s.followupEnabled,
    followup_template_name: s.followupTemplateName.trim() || null,
    followup_first_delay_hours: s.followupFirstDelayHours,
    followup_interval_hours: s.followupIntervalHours,
    followup_max_attempts: s.followupMaxAttempts,
    proactive_template_language: s.templateLanguage.trim() || 'en',
    proactive_daily_cap: s.dailyCap,
  };
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))
        }
        disabled={disabled}
      />
    </div>
  );
}

export function AiProactiveCard({
  value,
  onChange,
  disabled,
  assistantActive,
}: {
  value: ProactiveState;
  onChange: (next: ProactiveState) => void;
  disabled: boolean;
  assistantActive: boolean;
}) {
  const set = <K extends keyof ProactiveState>(k: K, v: ProactiveState[K]) =>
    onChange({ ...value, [k]: v });
  const off = disabled || !assistantActive;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="text-primary h-4 w-4" /> Proactive agent
        </CardTitle>
        <CardDescription>
          Let the AI open conversations with new leads and nudge people who go
          quiet. WhatsApp only allows free-form messages within 24 hours of the
          customer&apos;s last message, so cold leads get an approved template
          first and the AI takes over when they reply. Requires the assistant
          above to be enabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border-border space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-foreground text-sm font-medium">
                Greet new leads
              </p>
              <p className="text-muted-foreground text-xs">
                Sends your approved template to contacts added after you turn
                this on and who haven&apos;t messaged yet.
              </p>
            </div>
            <Switch
              checked={value.outreachEnabled}
              onCheckedChange={(v) => set('outreachEnabled', v)}
              disabled={off}
            />
          </div>
          {value.outreachEnabled && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ai-outreach-tpl" className="text-xs">
                  Approved template name
                </Label>
                <Input
                  id="ai-outreach-tpl"
                  value={value.outreachTemplateName}
                  onChange={(e) => set('outreachTemplateName', e.target.value)}
                  placeholder="welcome_new_lead"
                  disabled={off}
                />
              </div>
              <NumberField
                id="ai-outreach-delay"
                label="Wait (minutes)"
                value={value.outreachDelayMinutes}
                min={1}
                max={1440}
                onChange={(n) => set('outreachDelayMinutes', n)}
                disabled={off}
              />
            </div>
          )}
        </div>

        <div className="border-border space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-foreground text-sm font-medium">
                Re-engage quiet leads
              </p>
              <p className="text-muted-foreground text-xs">
                Friendly AI follow-ups when the customer stops replying in a
                chat the AI is handling (it auto-replied or sent the opener;
                flows and broadcasts are left alone). Stops
                on opt-out words (&quot;stop&quot;, &quot;not interested&quot;,
                &quot;mat bhejo&quot;), human takeover, or after the max.
              </p>
            </div>
            <Switch
              checked={value.followupEnabled}
              onCheckedChange={(v) => set('followupEnabled', v)}
              disabled={off}
            />
          </div>
          {value.followupEnabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField
                  id="ai-fu-first"
                  label="First nudge after (hours)"
                  value={value.followupFirstDelayHours}
                  min={1}
                  max={720}
                  onChange={(n) => set('followupFirstDelayHours', n)}
                  disabled={off}
                />
                <NumberField
                  id="ai-fu-interval"
                  label="Then every (hours)"
                  value={value.followupIntervalHours}
                  min={1}
                  max={720}
                  onChange={(n) => set('followupIntervalHours', n)}
                  disabled={off}
                />
                <NumberField
                  id="ai-fu-max"
                  label="Max nudges"
                  value={value.followupMaxAttempts}
                  min={1}
                  max={10}
                  onChange={(n) => set('followupMaxAttempts', n)}
                  disabled={off}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-fu-tpl" className="text-xs">
                  Template for chats older than 24h{' '}
                  <span className="text-muted-foreground font-normal">
                    (optional — without it, only chats inside the 24h window
                    get nudged)
                  </span>
                </Label>
                <Input
                  id="ai-fu-tpl"
                  value={value.followupTemplateName}
                  onChange={(e) => set('followupTemplateName', e.target.value)}
                  placeholder="checking_in"
                  disabled={off}
                />
              </div>
            </>
          )}
        </div>

        {(value.outreachEnabled || value.followupEnabled) && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="ai-tpl-lang" className="text-xs">
                Template language code
              </Label>
              <Input
                id="ai-tpl-lang"
                value={value.templateLanguage}
                onChange={(e) => set('templateLanguage', e.target.value)}
                placeholder="en"
                disabled={off}
              />
            </div>
            <NumberField
              id="ai-daily-cap"
              label="Max proactive messages / 24h"
              value={value.dailyCap}
              min={1}
              max={5000}
              onChange={(n) => set('dailyCap', n)}
              disabled={off}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
