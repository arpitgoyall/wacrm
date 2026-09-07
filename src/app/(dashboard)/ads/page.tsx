'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Megaphone,
  Users,
  GitBranch,
  Trophy,
  DollarSign,
  Percent,
  TrendingUp,
  ExternalLink,
  Pencil,
  Check,
  X,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { formatCurrency } from '@/lib/currency';
import {
  loadAdPerformance,
  groupAdPerformance,
  type AdPerformanceResult,
  type AdPerformanceRow,
  type AdGroupBy,
} from '@/lib/ads/performance';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function formatPct(n: number): string {
  const p = n * 100;
  if (p === 0) return '0%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

function formatRoas(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(2)}×`;
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const GROUP_OPTIONS: AdGroupBy[] = ['ad', 'adset', 'campaign'];

export default function AdsPage() {
  const t = useTranslations('Ads');
  const { defaultCurrency } = useAuth();
  const canManage = useCan('edit-settings');

  const [data, setData] = useState<AdPerformanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<AdGroupBy>('ad');
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    loadAdPerformance(createClient())
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => {
        console.error('[ads] load failed:', err);
        setError(err instanceof Error ? err.message : 'load failed');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.summary?.errors?.length) {
        throw new Error(body?.summary?.errors?.[0] ?? 'sync failed');
      }
      toast.success(t('sync.done'));
      load();
    } catch (err) {
      console.error('[ads] sync failed:', err);
      toast.error(t('sync.error'));
    } finally {
      setSyncing(false);
    }
  }

  function applyRename(sourceId: string, label: string | null) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.source_id === sourceId ? { ...r, label } : r
            ),
          }
        : prev
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{t('error')}</p>
        <Button variant="outline" onClick={load}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  const { rows, summary, sync } = data;
  const hasSpend = summary.totalSpend > 0;
  const lastSynced = timeAgo(sync.syncedAt);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        {sync.connected && (
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs">
              {sync.error
                ? t('sync.error')
                : lastSynced
                  ? t('sync.lastSynced', { time: lastSynced })
                  : t('sync.never')}
            </span>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={syncNow}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t('sync.now')}
              </Button>
            )}
          </div>
        )}
      </div>

      {!sync.enabled && (
        <p className="border-border bg-card/40 text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs">
          {t('sync.disabled')}
        </p>
      )}

      {/* Summary tiles */}
      <div
        className={cn(
          'border-border bg-card/60 grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-3',
          hasSpend ? 'xl:grid-cols-7' : 'xl:grid-cols-5'
        )}
      >
        <SummaryTile
          icon={<Megaphone className="text-muted-foreground h-4 w-4" />}
          label={t('summary.ads')}
          value={String(summary.adCount)}
        />
        <SummaryTile
          icon={<Users className="h-4 w-4 text-blue-400" />}
          label={t('summary.leads')}
          value={summary.totalLeads.toLocaleString()}
        />
        <SummaryTile
          icon={<GitBranch className="h-4 w-4 text-purple-400" />}
          label={t('summary.deals')}
          value={summary.totalDeals.toLocaleString()}
        />
        <SummaryTile
          icon={<Trophy className="text-primary h-4 w-4" />}
          label={t('summary.won')}
          value={summary.totalWon.toLocaleString()}
        />
        <SummaryTile
          icon={<DollarSign className="text-primary h-4 w-4" />}
          label={t('summary.revenue')}
          value={formatCurrency(summary.totalRevenue, defaultCurrency)}
        />
        {hasSpend && (
          <SummaryTile
            icon={<DollarSign className="h-4 w-4 text-amber-400" />}
            label={t('summary.spend')}
            value={formatCurrency(summary.totalSpend, defaultCurrency)}
          />
        )}
        {hasSpend && (
          <SummaryTile
            icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
            label={t('summary.roas')}
            value={formatRoas(summary.blendedRoas)}
          />
        )}
        {!hasSpend && (
          <SummaryTile
            icon={<Percent className="h-4 w-4 text-emerald-400" />}
            label={t('summary.closeRate')}
            value={formatPct(summary.blendedCloseRate)}
          />
        )}
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card/40 flex h-56 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-xl">
            <Megaphone className="text-primary h-6 w-6" />
          </div>
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('empty.title')}
          </p>
          <p className="text-muted-foreground mt-1 max-w-sm text-xs">
            {t('empty.desc')}
          </p>
        </div>
      ) : (
        <>
          {/* Grouping toggle */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground mr-1">
              {t('groupBy.label')}
            </span>
            {GROUP_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setGroupBy(opt)}
                className={cn(
                  'rounded-md px-2.5 py-1 font-medium transition-colors',
                  groupBy === opt
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {t(`groupBy.${opt}`)}
              </button>
            ))}
          </div>

          {groupBy === 'ad' ? (
            <AdTable
              rows={rows}
              currency={defaultCurrency}
              hasSpend={hasSpend}
              canRename={canManage}
              onRenamed={applyRename}
              t={t}
            />
          ) : (
            <GroupTable
              rows={groupAdPerformance(rows, groupBy)}
              currency={defaultCurrency}
              hasSpend={hasSpend}
              t={t}
            />
          )}
        </>
      )}

      <p className="text-muted-foreground text-xs">{t('attributionNote')}</p>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-muted/50 rounded-lg p-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium tracking-wider uppercase">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-foreground mt-1 text-base font-semibold">{value}</p>
    </div>
  );
}

function Th({
  children,
  first,
  last,
}: {
  children: React.ReactNode;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <th
      className={cn(
        'py-3 text-right',
        first && 'px-4 text-left',
        last && 'px-4',
        !first && !last && 'px-3'
      )}
    >
      {children}
    </th>
  );
}

function money(v: number, currency: string): string {
  return v > 0 ? formatCurrency(Math.round(v), currency) : '—';
}

type T = ReturnType<typeof useTranslations>;

function AdTable({
  rows,
  currency,
  hasSpend,
  canRename,
  onRenamed,
  t,
}: {
  rows: AdPerformanceRow[];
  currency: string;
  hasSpend: boolean;
  canRename: boolean;
  onRenamed: (sourceId: string, label: string | null) => void;
  t: T;
}) {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-border text-muted-foreground border-b text-[11px] font-medium tracking-wider uppercase">
            <Th first>{t('table.ad')}</Th>
            <Th>{t('table.leads')}</Th>
            <Th>{t('table.deals')}</Th>
            <Th>{t('table.won')}</Th>
            {hasSpend && <Th>{t('table.spend')}</Th>}
            <Th>{t('table.revenue')}</Th>
            {hasSpend && <Th>{t('table.roas')}</Th>}
            {hasSpend && <Th>{t('table.cpl')}</Th>}
            <Th last>{t('table.closeRate')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AdRow
              key={row.source_id}
              row={row}
              currency={currency}
              hasSpend={hasSpend}
              canRename={canRename && row.id !== null}
              onRenamed={(label) => onRenamed(row.source_id, label)}
              t={t}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupTable({
  rows,
  currency,
  hasSpend,
  t,
}: {
  rows: ReturnType<typeof groupAdPerformance>;
  currency: string;
  hasSpend: boolean;
  t: T;
}) {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-border text-muted-foreground border-b text-[11px] font-medium tracking-wider uppercase">
            <Th first>{t('table.group')}</Th>
            <Th>{t('table.ads')}</Th>
            <Th>{t('table.leads')}</Th>
            <Th>{t('table.deals')}</Th>
            <Th>{t('table.won')}</Th>
            {hasSpend && <Th>{t('table.spend')}</Th>}
            <Th>{t('table.revenue')}</Th>
            {hasSpend && <Th>{t('table.roas')}</Th>}
            <Th last>{t('table.closeRate')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr
              key={g.key}
              className="border-border/60 hover:bg-muted/30 border-b last:border-0"
            >
              <td className="truncate px-4 py-3 font-medium">{g.name}</td>
              <td className="px-3 py-3 text-right tabular-nums">{g.ads}</td>
              <td className="px-3 py-3 text-right tabular-nums">
                {g.leads.toLocaleString()}
              </td>
              <td className="text-muted-foreground px-3 py-3 text-right tabular-nums">
                {g.deals.toLocaleString()}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {g.won.toLocaleString()}
              </td>
              {hasSpend && (
                <td className="px-3 py-3 text-right text-amber-500/90 tabular-nums">
                  {money(g.spend, currency)}
                </td>
              )}
              <td className="px-3 py-3 text-right font-medium tabular-nums">
                {formatCurrency(g.revenue, currency)}
              </td>
              {hasSpend && (
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatRoas(g.roas)}
                </td>
              )}
              <td className="px-4 py-3 text-right tabular-nums">
                {formatPct(g.closeRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdRow({
  row,
  currency,
  hasSpend,
  canRename,
  onRenamed,
  t,
}: {
  row: AdPerformanceRow;
  currency: string;
  hasSpend: boolean;
  canRename: boolean;
  onRenamed: (label: string | null) => void;
  t: T;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.label ?? '');
  const [saving, setSaving] = useState(false);

  const displayName =
    row.label || row.metaName || row.headline || row.source_id;
  const secondary =
    displayName !== row.source_id
      ? row.campaignName || row.source_id
      : row.campaignName;

  async function save() {
    if (!row.id || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ads/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? 'rename failed');
      }
      const body = await res.json();
      onRenamed(body?.ad?.label ?? null);
      toast.success(t('rename.saved'));
      setEditing(false);
    } catch (err) {
      console.error('[ads] rename failed:', err);
      toast.error(t('rename.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-border/60 hover:bg-muted/30 border-b last:border-0">
      <td className="px-4 py-3">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
              maxLength={120}
              placeholder={t('rename.placeholder')}
              aria-label={t('rename.label')}
              className="border-border bg-background focus:border-primary w-56 rounded-md border px-2 py-1 text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              aria-label={t('rename.save')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label={t('rename.cancel')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'truncate font-medium',
                    row.label ? 'text-foreground' : 'text-muted-foreground'
                  )}
                  title={displayName}
                >
                  {displayName}
                </span>
                {row.source_url && (
                  <a
                    href={row.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('openAd')}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              {secondary && (
                <span className="text-muted-foreground block truncate text-[11px]">
                  {secondary}
                </span>
              )}
            </div>
            {canRename && (
              <button
                type="button"
                onClick={() => {
                  setDraft(row.label ?? '');
                  setEditing(true);
                }}
                aria-label={t('rename.label')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-50 transition-opacity hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {row.leads.toLocaleString()}
      </td>
      <td className="text-muted-foreground px-3 py-3 text-right tabular-nums">
        {row.deals.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {row.won.toLocaleString()}
      </td>
      {hasSpend && (
        <td className="px-3 py-3 text-right text-amber-500/90 tabular-nums">
          {money(row.spend, currency)}
        </td>
      )}
      <td className="px-3 py-3 text-right font-medium tabular-nums">
        {formatCurrency(row.revenue, currency)}
      </td>
      {hasSpend && (
        <td className="px-3 py-3 text-right tabular-nums">
          {formatRoas(row.roas)}
        </td>
      )}
      {hasSpend && (
        <td className="text-muted-foreground px-3 py-3 text-right tabular-nums">
          {row.cpl == null ? '—' : money(row.cpl, currency)}
        </td>
      )}
      <td className="px-4 py-3 text-right tabular-nums">
        {formatPct(row.closeRate)}
      </td>
    </tr>
  );
}
