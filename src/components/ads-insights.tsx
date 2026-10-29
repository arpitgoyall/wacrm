'use client';

import { useEffect, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/currency';
import type { AdPerformanceResult } from '@/lib/ads/performance';
import {
  presetPeriod,
  performanceFlags,
  type ReportPeriod,
} from '@/lib/ads/reporting';

export function AdsPeriodPicker({
  period,
  onChange,
}: {
  period: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
}) {
  const [preset, setPreset] = useState('30');
  const [custom, setCustom] = useState(period);
  const valid = Boolean(
    custom.start && custom.end && custom.start <= custom.end
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        Reporting period
        <select
          aria-label="Reporting period"
          value={preset}
          className="border-border bg-background ml-2 rounded-md border p-2"
          onChange={(e) => {
            const value = e.target.value;
            setPreset(value);
            if (value !== 'custom')
              onChange(
                value === 'all'
                  ? { ...period, start: '', end: '' }
                  : presetPeriod(Number(value), period.currency)
              );
          }}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {preset === 'custom' && (
        <>
          <label className="text-xs">
            From
            <input
              aria-label="From date"
              type="date"
              value={custom.start}
              onChange={(e) => setCustom({ ...custom, start: e.target.value })}
              className="border-border bg-background ml-2 rounded border p-2"
            />
          </label>
          <label className="text-xs">
            To
            <input
              aria-label="To date"
              type="date"
              value={custom.end}
              min={custom.start}
              onChange={(e) => setCustom({ ...custom, end: e.target.value })}
              className="border-border bg-background ml-2 rounded border p-2"
            />
          </label>
          <Button
            disabled={!valid}
            onClick={() => onChange({ ...custom, currency: period.currency })}
          >
            Apply dates
          </Button>
        </>
      )}
      <span className="text-muted-foreground text-xs">
        CRM dates use UTC; Meta uses its reporting dates. Wins and revenue use
        deal creation dates and current status.
      </span>
    </div>
  );
}

export function AdsInsights({
  data,
  currency,
  canManage,
}: {
  data: AdPerformanceResult;
  currency: string;
  canManage: boolean;
}) {
  const [targets, setTargets] = useState({ max_cpl: '', min_roas: '' });
  const [ready, setReady] = useState(false);
  const [savedTargets, setSavedTargets] = useState({
    max_cpl: '',
    min_roas: '',
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/ads/targets')
      .then(async (res) => {
        if (!res.ok) throw Error();
        return res.json();
      })
      .then((body) => {
        if (!cancelled) {
          const value = {
            max_cpl: body.targets.max_cpl?.toString() ?? '',
            min_roas: body.targets.min_roas?.toString() ?? '',
          };
          setTargets(value);
          setSavedTargets(value);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled)
          toast.error(
            'Could not load workspace targets. Apply the ads insights migration if needed.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const r = data.reporting;
  const flags = performanceFlags(
    data.rows,
    ready ? savedTargets : { max_cpl: '', min_roas: '' }
  );
  const stale =
    data.sync.syncedAt &&
    Date.now() - Date.parse(data.sync.syncedAt) > 2 * 60 * 60 * 1000;
  return (
    <div className="space-y-5">
      <div
        role="status"
        className="border-border text-muted-foreground space-y-1 rounded-xl border p-4 text-xs"
      >
        <p>
          {data.sync.error
            ? 'Latest Meta sync failed. Figures may be incomplete; check the connection in Settings.'
            : !data.sync.connected
              ? 'Connect a Meta ad account in Settings to see spend and messaging insights.'
              : !data.sync.syncedAt
                ? 'Meta data has not synced yet.'
                : stale
                  ? 'Meta data is more than two hours old. Sync now for updated results.'
                  : 'Meta data is up to date with the latest scheduled sync.'}
        </p>
        <p>
          {r.capturedLeads} leads have recorded acquisition history;{' '}
          {r.fallbackLeads} use the contact’s current ad because original
          attribution is unavailable.
        </p>
        {r.insightStart && (
          <p>
            Stored Meta history begins {r.insightStart}. Earlier spend may be
            incomplete.
          </p>
        )}
        {r.readError && (
          <p>
            Some reporting data could not be loaded. Totals may be incomplete.
          </p>
        )}
        {!r.currencyCompatible && (
          <p>
            ROAS and cost comparisons are unavailable when Meta spend currency
            is missing, mixed, or differs from workspace revenue currency.
          </p>
        )}
      </div>
      <section className="border-border bg-card rounded-xl border p-4">
        <h2 className="font-semibold">Daily spend and CRM leads</h2>
        <p className="text-muted-foreground mb-4 text-xs">
          Spend follows Meta insight dates; leads follow contact creation dates.
          These series describe activity, rather than a single conversion
          cohort.
        </p>
        {r.daily.some((point) => point.leads > 0 || point.spend > 0) ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={r.daily}>
                <XAxis dataKey="date" minTickGap={45} />
                <YAxis yAxisId="spend" hide={!r.spendCurrency} />
                <YAxis
                  yAxisId="leads"
                  orientation="right"
                  allowDecimals={false}
                />
                <Tooltip />
                <Legend />
                {r.spendCurrency && (
                  <Bar
                    yAxisId="spend"
                    dataKey="spend"
                    name={`Spend (${r.spendCurrency || 'currency unavailable'})`}
                    fill="#f59e0b"
                  />
                )}
                <Line
                  yAxisId="leads"
                  dataKey="leads"
                  name="CRM leads"
                  stroke="#3b82f6"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-muted-foreground py-10 text-center text-sm">
            No daily activity recorded for this period.
          </p>
        )}
      </section>
      <section className="border-border bg-card rounded-xl border p-4">
        <h2 className="mb-3 font-semibold">Messaging and sales funnel</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {[
            ['Impressions', r.impressions],
            ['Link clicks', r.clicks],
            ['Meta messaging starts', r.messaging],
            ['CRM leads', data.summary.totalLeads],
            ['Deals created', data.summary.totalDeals],
            ['Won deals', data.summary.totalWon],
          ].map(([label, value]) => (
            <div key={label} className="bg-muted/40 rounded-lg p-3">
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="text-lg font-semibold">
                {Number(value).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Meta messaging starts and CRM leads are measured independently. Deal
          totals can include leads created before this period.
        </p>
        <p className="mt-3 text-sm">
          CPL:{' '}
          {data.summary.blendedCpl == null
            ? '—'
            : formatCurrency(data.summary.blendedCpl, currency)}{' '}
          · Cost per deal:{' '}
          {r.currencyCompatible &&
          data.summary.totalDeals &&
          data.summary.totalSpend
            ? formatCurrency(
                data.summary.totalSpend / data.summary.totalDeals,
                currency
              )
            : '—'}
        </p>
      </section>
      <section className="border-border bg-card rounded-xl border p-4">
        <h2 className="mb-3 font-semibold">Workspace performance targets</h2>
        <div className="flex flex-wrap items-end gap-3">
          {(['max_cpl', 'min_roas'] as const).map((key) => (
            <label key={key} className="text-xs">
              {key === 'max_cpl' ? `Maximum CPL (${currency})` : 'Minimum ROAS'}
              <input
                disabled={!ready || !canManage || saving}
                type="number"
                min="0.01"
                step="0.01"
                value={targets[key]}
                onChange={(e) =>
                  setTargets({ ...targets, [key]: e.target.value })
                }
                className="border-border bg-background mt-1 block rounded-md border p-2"
              />
            </label>
          ))}
          {canManage && (
            <Button
              disabled={
                !ready ||
                saving ||
                Object.values(targets).some(
                  (v) =>
                    v !== '' && (!Number.isFinite(Number(v)) || Number(v) <= 0)
                )
              }
              onClick={async () => {
                setSaving(true);
                try {
                  const response = await fetch('/api/ads/targets', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      max_cpl: targets.max_cpl ? Number(targets.max_cpl) : null,
                      min_roas: targets.min_roas
                        ? Number(targets.min_roas)
                        : null,
                    }),
                  });
                  if (!response.ok) throw Error();
                  setSavedTargets(targets);
                  toast.success('Workspace targets saved');
                } catch {
                  toast.error('Could not save workspace targets');
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? 'Saving…' : 'Save targets'}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Shared with your workspace. Clear a target to disable it. Flags advise
          your team and do not change campaigns.
        </p>
        <h3 className="mt-4 text-sm font-medium">Performance opportunities</h3>
        {flags.length ? (
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
            {flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-2 text-xs">
            No flags for the current period and targets.
          </p>
        )}
      </section>
    </div>
  );
}
