'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Megaphone,
  Users,
  GitBranch,
  Trophy,
  DollarSign,
  Percent,
  ExternalLink,
  Pencil,
  Check,
  X,
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
  type AdPerformanceRow,
} from '@/lib/ads/performance';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function formatPct(n: number): string {
  const p = n * 100;
  if (p === 0) return '0%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export default function AdsPage() {
  const t = useTranslations('Ads');
  const { defaultCurrency } = useAuth();
  const canRename = useCan('edit-settings');

  const [rows, setRows] = useState<AdPerformanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    loadAdPerformance(createClient())
      .then((res) => {
        setRows(res.rows);
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

  const summary = useMemo(() => {
    const list = rows ?? [];
    const totalLeads = list.reduce((s, r) => s + r.leads, 0);
    const totalWon = list.reduce((s, r) => s + r.won, 0);
    return {
      adCount: list.length,
      totalLeads,
      totalDeals: list.reduce((s, r) => s + r.deals, 0),
      totalWon,
      totalRevenue: list.reduce((s, r) => s + r.revenue, 0),
      blendedCloseRate: totalLeads > 0 ? totalWon / totalLeads : 0,
    };
  }, [rows]);

  function applyRename(sourceId: string, label: string | null) {
    setRows(
      (prev) =>
        prev?.map((r) => (r.source_id === sourceId ? { ...r, label } : r)) ??
        prev
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

  if (rows === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      {/* Summary tiles */}
      <div className="border-border bg-card/60 grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-3 xl:grid-cols-6">
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
        <SummaryTile
          icon={<Percent className="h-4 w-4 text-emerald-400" />}
          label={t('summary.closeRate')}
          value={formatPct(summary.blendedCloseRate)}
        />
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
        <div className="border-border bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left text-[11px] font-medium tracking-wider uppercase">
                <th className="px-4 py-3">{t('table.ad')}</th>
                <th className="px-3 py-3 text-right">{t('table.leads')}</th>
                <th className="px-3 py-3 text-right">{t('table.deals')}</th>
                <th className="px-3 py-3 text-right">{t('table.won')}</th>
                <th className="px-3 py-3 text-right">{t('table.lost')}</th>
                <th className="px-3 py-3 text-right">{t('table.revenue')}</th>
                <th className="px-3 py-3 text-right">{t('table.closeRate')}</th>
                <th className="px-4 py-3 text-right">
                  {t('table.revPerLead')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AdRow
                  key={row.source_id}
                  row={row}
                  currency={defaultCurrency}
                  canRename={canRename && row.id !== null}
                  onRenamed={(label) => applyRename(row.source_id, label)}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </div>
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

function AdRow({
  row,
  currency,
  canRename,
  onRenamed,
  t,
}: {
  row: AdPerformanceRow;
  currency: string;
  canRename: boolean;
  onRenamed: (label: string | null) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.label ?? '');
  const [saving, setSaving] = useState(false);

  const displayName = row.label || row.headline || row.source_id;
  const showId = displayName !== row.source_id;

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
              {showId && (
                <span className="text-muted-foreground block truncate text-[11px]">
                  {row.source_id}
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
      <td className="text-muted-foreground px-3 py-3 text-right tabular-nums">
        {row.lost.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-right font-medium tabular-nums">
        {formatCurrency(row.revenue, currency)}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {formatPct(row.closeRate)}
      </td>
      <td className="text-muted-foreground px-4 py-3 text-right tabular-nums">
        {row.revenuePerLead > 0
          ? formatCurrency(Math.round(row.revenuePerLead), currency)
          : '—'}
      </td>
    </tr>
  );
}
