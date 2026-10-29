'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Megaphone,
  Plus,
  RefreshCw,
  Search,
  X,
  ArrowUpRight,
  Download,
  SlidersHorizontal,
  MessageCircle,
} from 'lucide-react';
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
import { formatAdMoney as formatCurrency } from '@/lib/ads/workspace-report';
import { cn } from '@/lib/utils';
import type { CampaignMetrics } from '@/lib/ads/workspace-report';
import type { CampaignEntity } from '@/lib/ads/workspace';
import {
  adsRequest,
  fieldClass,
  object,
  type WorkspaceData,
  type WorkspaceDocument,
  type ChangeRecord,
} from './workspace-types';
import { CampaignWizard } from './campaign-wizard';
import { WorkspaceSettings } from './workspace-settings';
import { LeadQuality } from './lead-quality';
import { ChangeReview } from './change-review';
import { CampaignDetailTrend } from './campaign-detail-trend';

const tabs = [
  'Overview',
  'Campaigns',
  'Creative Library',
  'Lead Quality',
  'Reports',
  'Settings',
] as const;
type Tab = (typeof tabs)[number];
const metricColumns = [
  'spend',
  'leads',
  'qualified',
  'cpql',
  'customers',
  'revenue',
  'roas',
  'dailyBudget',
] as const;
type MetricKey = (typeof metricColumns)[number];
const metricNames: Record<MetricKey, string> = {
  spend: 'Spend',
  leads: 'CRM leads',
  qualified: 'Qualified',
  cpql: 'Cost / qualified',
  customers: 'Customers',
  revenue: 'Sales revenue',
  roas: 'ROAS',
  dailyBudget: 'Daily budget',
};
const dateRange = (
  days: number,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone
) => {
  const end = new Date().toLocaleDateString('en-CA', { timeZone: zone });
  const start = new Date(end + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: start.toISOString().slice(0, 10), end };
};
function currency(value: number | null, code: string) {
  return value == null ? '—' : formatCurrency(value, code);
}
function delta(current: number, previous: number) {
  return previous
    ? `${current >= previous ? '+' : ''}${(((current - previous) / previous) * 100).toFixed(1)}% vs previous period`
    : 'No comparable previous value';
}
function escapeCsv(value: unknown) {
  const s = String(value ?? '');
  return (
    '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
  );
}
export function exportCampaignCsv(rows: CampaignMetrics[], code: string) {
  const csv = [
    ['Campaign', 'Currency', ...metricColumns.map((c) => metricNames[c])],
    ...rows.map((r) => [r.name, code, ...metricColumns.map((c) => r[c])]),
  ]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(
    new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'campaign-performance.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function CampaignWorkspace() {
  const [data, setData] = useState<WorkspaceData | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState(''),
    [range, setRange] = useState(() => dateRange(30)),
    [dates, setDates] = useState(range);
  const [tab, setTab] = useState<Tab>('Overview'),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all');
  const [journeyFilter, setJourneyFilter] = useState('all');
  const [level, setLevel] = useState<'campaigns' | 'adsets' | 'ads'>(
    'campaigns'
  );
  const [columns, setColumns] = useState<MetricKey[]>([...metricColumns]),
    [showColumns, setShowColumns] = useState(false);
  const [picked, setPicked] = useState<string[]>([]),
    [bulkReview, setBulkReview] = useState<ChangeRecord[] | null>(null);
  const [selected, setSelected] = useState<CampaignEntity | null>(null),
    [review, setReview] = useState<ChangeRecord | null>(null);
  const [wizard, setWizard] = useState<{
      existing: WorkspaceDocument | null;
      creative?: WorkspaceDocument;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{
      kind: string;
      existing?: WorkspaceDocument;
    } | null>(null),
    [form, setForm] = useState<Record<string, string>>({});
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await adsRequest<WorkspaceData>(
        `/api/ads/workspace?connection=${connection}&start=${range.start}&end=${range.end}`
      );
      if (id !== requestId.current) return;
      setData(result);
      setError('');
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [connection, range]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get('section') === 'settings'
    )
      setTab('Settings');
  }, []);
  const canManage = data?.role === 'owner' || data?.role === 'admin';
  const code = data?.connection?.currency || 'USD',
    report = data?.report;
  const rows = (report?.[level] || []).filter(
    (r) =>
      r.name.toLowerCase().includes(query.toLowerCase()) &&
      (status === 'all' || r.status === status)
  );
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const saveDocument = (
    kind: string,
    name: string,
    payload: Record<string, unknown>,
    existing?: WorkspaceDocument
  ) =>
    adsRequest('/api/ads/workspace', {
      action: 'document',
      kind,
      name,
      data: payload,
      id: existing?.id,
      revision: existing?.revision,
    });
  const metric = (row: CampaignMetrics, key: MetricKey) =>
    key === 'roas'
      ? row.roas == null
        ? '—'
        : `${row.roas.toFixed(2)}×`
      : ['spend', 'cpql', 'revenue', 'dailyBudget'].includes(key)
        ? currency(row[key] as number | null, code)
        : Number(row[key] || 0).toLocaleString();
  const openEditor = (kind: string, existing?: WorkspaceDocument) => {
    setForm(
      Object.fromEntries(
        Object.entries(existing?.data || {}).map(([key, value]) => [
          key,
          String(value),
        ])
      )
    );
    setEditor({ kind, existing });
  };
  const thumbnail = (entity?: CampaignEntity) => {
    const creative = object(entity?.data.creative);
    return String(creative.thumbnail_url || creative.image_url || '');
  };
  const previewFor = (id: string) => {
    const e = data?.entities.find((e) => e.meta_id === id);
    if (e?.kind === 'ad') return e;
    const sets =
      data?.entities
        .filter((s) => s.kind === 'adset' && s.parent_id === id)
        .map((s) => s.meta_id) || [];
    return data?.entities.find(
      (a) =>
        a.kind === 'ad' &&
        (a.parent_id === id || sets.includes(a.parent_id || ''))
    );
  };

  return (
    <div className="space-y-5" aria-busy={loading}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div className="bg-primary/10 text-primary flex h-11 w-11 items-center justify-center rounded-xl">
            <Megaphone size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Campaign workspace
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Connect advertising to conversations, qualified leads, and sales.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || loading} onClick={load}>
            <RefreshCw size={16} />
            Refresh
          </Button>
          {canManage && data?.connection && (
            <Button onClick={() => setWizard({ existing: null })}>
              <Plus size={16} />
              Create campaign
            </Button>
          )}
        </div>
      </header>
      <nav
        className="border-border flex gap-1 overflow-x-auto border-b"
        aria-label="Campaign workspace"
      >
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            aria-current={item === tab ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 px-4 py-3 text-sm transition-colors',
              tab === item
                ? 'border-primary text-primary font-semibold'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 rounded-lg border p-4 text-sm"
        >
          <p>{error}</p>
          <Button variant="outline" className="mt-3" onClick={load}>
            Try again
          </Button>
          <p className="text-muted-foreground mt-2">
            If this is a new installation, an administrator must finish the
            campaign workspace setup.
          </p>
        </div>
      )}
      {loading && !data && (
        <p role="status" className="text-muted-foreground py-12 text-center">
          Loading your campaign workspace…
        </p>
      )}
      {data && (
        <>
          <div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Ad account
                <select
                  className={cn(
                    fieldClass,
                    'ml-2 inline-block w-auto max-w-64'
                  )}
                  value={data.connection?.id || ''}
                  onChange={(e) => {
                    setConnection(e.target.value);
                    setSelected(null);
                    setPicked([]);
                  }}
                >
                  {data.connections.length ? (
                    data.connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.currency}
                      </option>
                    ))
                  ) : (
                    <option>No connected accounts</option>
                  )}
                </select>
              </label>
              {data.connection && (
                <span className="text-muted-foreground text-xs">
                  {data.connection.timezone} ·{' '}
                  {data.connection.synced_at
                    ? `Synced ${new Date(data.connection.synced_at).toLocaleString()}`
                    : 'Not synced'}
                </span>
              )}
            </div>
            {canManage && data.connection && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    adsRequest('/api/ads/connections', {
                      action: 'sync',
                      connectionId: data.connection!.id,
                    })
                  )
                }
              >
                <RefreshCw size={14} />
                Sync Meta
              </Button>
            )}
          </div>
          {data.connection?.error && (
            <p role="alert" className="text-sm text-amber-600">
              {data.connection.error}{' '}
              <button className="underline" onClick={() => setTab('Settings')}>
                Check connection
              </button>
            </p>
          )}
          {tab !== 'Settings' && data.connection && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Reporting preset"
                className={cn(fieldClass, 'w-auto')}
                defaultValue="30"
                onChange={(e) => {
                  if (e.target.value !== 'custom') {
                    const next = dateRange(
                      Number(e.target.value),
                      data.connection!.timezone
                    );
                    setDates(next);
                    setRange(next);
                  }
                }}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="custom">Custom dates</option>
              </select>
              <input
                aria-label="Start date"
                type="date"
                value={dates.start}
                className={cn(fieldClass, 'w-auto')}
                onChange={(e) => setDates({ ...dates, start: e.target.value })}
              />
              <span className="text-muted-foreground text-xs">to</span>
              <input
                aria-label="End date"
                type="date"
                value={dates.end}
                min={dates.start}
                className={cn(fieldClass, 'w-auto')}
                onChange={(e) => setDates({ ...dates, end: e.target.value })}
              />
              <Button
                variant="outline"
                disabled={
                  !dates.start ||
                  !dates.end ||
                  dates.start > dates.end ||
                  loading
                }
                onClick={() => setRange(dates)}
              >
                Apply
              </Button>
              {loading && (
                <span role="status" className="text-muted-foreground text-xs">
                  Updating report…
                </span>
              )}
            </div>
          )}
          {!data.connection && tab !== 'Settings' && (
            <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
              <MessageCircle className="text-primary mx-auto mb-3" size={32} />
              <h2 className="text-lg font-medium">
                Bring your WhatsApp campaigns into one view
              </h2>
              <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
                Connect a Meta ad account to see campaigns, including those that
                have not generated their first lead.
              </p>
              {canManage && (
                <Button className="mt-5" onClick={() => setTab('Settings')}>
                  Connect Meta
                </Button>
              )}
            </div>
          )}
          {tab === 'Overview' && report && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  [
                    'Spend',
                    report.summary.spend,
                    data.comparison?.summary.spend,
                    true,
                  ],
                  [
                    'Qualified leads',
                    report.summary.qualified,
                    data.comparison?.summary.qualified,
                    false,
                  ],
                  [
                    'Cost per qualified lead',
                    report.summary.cpql,
                    data.comparison?.summary.cpql,
                    true,
                  ],
                  [
                    'Sales revenue',
                    report.summary.revenue,
                    data.comparison?.summary.revenue,
                    true,
                  ],
                ].map(([label, value, previous, isMoney]) => (
                  <div
                    key={String(label)}
                    className="border-border bg-card rounded-xl border px-5 py-4"
                  >
                    <p className="text-muted-foreground text-sm">{label}</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                      {value == null
                        ? '—'
                        : isMoney
                          ? currency(Number(value), code)
                          : Number(value).toLocaleString()}
                    </p>
                    <p className="text-muted-foreground mt-2 text-xs">
                      {delta(Number(value), Number(previous))}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
                <section className="border-border bg-card min-w-0 rounded-xl border p-5">
                  <h2 className="font-semibold">
                    From spend to qualified interest
                  </h2>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Daily activity in {data.connection?.timezone}. Qualification
                    and sales use their outcome dates.
                  </p>
                  <div className="mt-5 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={report.daily}>
                        <XAxis dataKey="date" minTickGap={45} />
                        <YAxis yAxisId="money" />
                        <YAxis
                          yAxisId="count"
                          orientation="right"
                          allowDecimals={false}
                        />
                        <Tooltip />
                        <Legend />
                        <Bar
                          yAxisId="money"
                          dataKey="spend"
                          name={`Spend (${code})`}
                          fill="#94a3b8"
                          radius={[3, 3, 0, 0]}
                        />
                        <Line
                          yAxisId="count"
                          dataKey="qualified"
                          name="Qualified leads"
                          stroke="#16a34a"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="count"
                          dataKey="leads"
                          name="New CRM leads"
                          stroke="#3b82f6"
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </section>
                <section className="border-border bg-card rounded-xl border p-5">
                  <h2 className="font-semibold">Needs attention</h2>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Evidence to investigate before making changes.
                  </p>
                  <div className="mt-4 space-y-4">
                    {data.recommendations.slice(0, 3).map((r) => (
                      <button
                        className="border-border block w-full border-b pb-3 text-left last:border-0"
                        key={r.id}
                        onClick={() => {
                          setTab('Reports');
                        }}
                      >
                        <p className="text-sm font-medium">{r.title}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {r.evidence}
                        </p>
                      </button>
                    ))}
                    {!data.recommendations.length && (
                      <p className="text-muted-foreground text-sm">
                        No attention flags for this period. Continue monitoring
                        lead quality and sales.
                      </p>
                    )}
                  </div>
                </section>
              </div>
              <section className="border-border rounded-xl border p-5">
                <h2 className="mb-4 font-semibold">Customer journey</h2>
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    ['Ad-sourced leads', report.summary.leads, 'acquired'],
                    [
                      'Engaged contacts',
                      report.conversations.engaged,
                      'engaged',
                    ],
                    [
                      'Human answered conversations',
                      report.conversations.answeredByHuman,
                      'answered',
                    ],
                    [
                      'Qualified outcomes',
                      report.summary.qualified,
                      'qualifiedPeriod',
                    ],
                    ['Customers', report.summary.customers, 'customers'],
                  ].map(([label, value, stage]) => (
                    <button
                      key={label}
                      className="bg-muted/40 hover:bg-muted rounded-lg p-4 text-left"
                      onClick={() => {
                        setJourneyFilter(String(stage));
                        setTab('Lead Quality');
                      }}
                    >
                      <span className="text-muted-foreground text-xs">
                        {label}
                      </span>
                      <strong className="mt-2 block text-xl tabular-nums">
                        {value}
                      </strong>
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground mt-3 text-xs">
                  These are period activity measures, not a single conversion
                  cohort. Outcomes may belong to older leads.{' '}
                  {report.fallbackLeads} new leads use current-source fallback
                  because original attribution is unavailable.
                </p>
                {report.summary.currencyMismatch && (
                  <p className="mt-2 text-xs text-amber-600">
                    Some confirmed sales use a different currency. Revenue shows
                    matching-currency sales only; ROAS is unavailable.
                  </p>
                )}
              </section>
            </>
          )}
          {tab === 'Campaigns' && report && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1">
                  <Search
                    size={16}
                    className="text-muted-foreground absolute top-3 left-3"
                  />
                  <input
                    aria-label="Search campaigns"
                    placeholder="Search by name"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className={cn(fieldClass, 'pl-9')}
                  />
                </div>
                <select
                  className={cn(fieldClass, 'w-auto')}
                  aria-label="Campaign level"
                  value={level}
                  onChange={(e) => {
                    setLevel(e.target.value as typeof level);
                    setPicked([]);
                  }}
                >
                  <option value="campaigns">Campaigns</option>
                  <option value="adsets">Ad sets</option>
                  <option value="ads">Ads</option>
                </select>
                <select
                  aria-label="Filter status"
                  className={cn(fieldClass, 'w-auto')}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {[...new Set((report[level] || []).map((r) => r.status))]
                    .filter(Boolean)
                    .map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                </select>
                <Button
                  variant="outline"
                  onClick={() => setShowColumns(!showColumns)}
                >
                  <SlidersHorizontal size={16} />
                  Columns
                </Button>
                {canManage && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setForm({ name: '' });
                      setEditor({ kind: 'view' });
                    }}
                  >
                    Save view
                  </Button>
                )}
                <select
                  aria-label="Saved view"
                  className={cn(fieldClass, 'w-auto')}
                  defaultValue=""
                  onChange={(e) => {
                    const view = data.documents.find(
                      (d) => d.id === e.target.value
                    );
                    if (view) {
                      setQuery(String(view.data.query || ''));
                      setStatus(String(view.data.status || 'all'));
                      setColumns(
                        (view.data.columns || metricColumns) as MetricKey[]
                      );
                      setLevel(
                        (view.data.level || 'campaigns') as typeof level
                      );
                    }
                  }}
                >
                  <option value="">Saved views</option>
                  {data.documents
                    .filter((d) => d.kind === 'view')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </div>
              {showColumns && (
                <div className="flex flex-wrap gap-4 rounded-lg border p-3">
                  {metricColumns.map((c) => (
                    <label key={c} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={columns.includes(c)}
                        onChange={(e) =>
                          setColumns(
                            e.target.checked
                              ? [...columns, c]
                              : columns.filter((k) => k !== c)
                          )
                        }
                      />
                      {metricNames[c]}
                    </label>
                  ))}
                </div>
              )}
              <div className="border-border bg-card overflow-auto rounded-xl border">
                {canManage && picked.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-b p-3">
                    <span className="text-sm">{picked.length} selected</span>
                    {['PAUSED', 'ACTIVE'].map((delivery) => (
                      <Button
                        size="sm"
                        variant="outline"
                        key={delivery}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const reviews: ChangeRecord[] = [];
                            for (const id of picked) {
                              const result = await adsRequest<{
                                review: ChangeRecord;
                              }>('/api/ads/actions', {
                                action: 'status',
                                connectionId: data.connection!.id,
                                entityId: id,
                                status: delivery,
                              });
                              reviews.push(result.review);
                            }
                            setBulkReview(reviews);
                          })
                        }
                      >
                        {delivery === 'ACTIVE'
                          ? 'Review bulk activation'
                          : 'Review bulk pause'}
                      </Button>
                    ))}
                  </div>
                )}
                <table className="w-full min-w-[800px] text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      {canManage && (
                        <th className="p-3">
                          <input
                            type="checkbox"
                            aria-label="Select all visible campaign items"
                            checked={
                              rows.length > 0 &&
                              rows.every((r) => picked.includes(r.id))
                            }
                            onChange={(e) =>
                              setPicked(
                                e.target.checked ? rows.map((r) => r.id) : []
                              )
                            }
                          />
                        </th>
                      )}
                      <th className="p-4 text-left font-medium">
                        {level === 'campaigns'
                          ? 'Campaign'
                          : level === 'adsets'
                            ? 'Ad set'
                            : 'Ad'}
                      </th>
                      <th className="p-3 text-left font-medium">Delivery</th>
                      {columns.map((c) => (
                        <th
                          key={c}
                          className="p-3 text-right font-medium whitespace-nowrap"
                        >
                          {metricNames[c]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const entity = data.entities.find(
                        (e) => e.meta_id === row.id
                      );
                      const thumb = thumbnail(previewFor(row.id));
                      return (
                        <tr
                          key={row.id}
                          className="border-border hover:bg-muted/30 border-t"
                        >
                          {canManage && (
                            <td className="p-3">
                              <input
                                type="checkbox"
                                aria-label={`Select ${row.name}`}
                                checked={picked.includes(row.id)}
                                onChange={(e) =>
                                  setPicked(
                                    e.target.checked
                                      ? [...picked, row.id]
                                      : picked.filter((id) => id !== row.id)
                                  )
                                }
                              />
                            </td>
                          )}
                          <td className="p-4">
                            <button
                              className="hover:text-primary flex items-center gap-3 text-left font-medium"
                              onClick={() => setSelected(entity || null)}
                            >
                              {thumb ? (
                                <Image
                                  src={thumb}
                                  width={40}
                                  height={40}
                                  unoptimized
                                  alt=""
                                  className="h-10 w-10 rounded-lg object-cover"
                                />
                              ) : (
                                <span className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                                  <Megaphone size={17} />
                                </span>
                              )}
                              <span>{row.name}</span>
                            </button>
                          </td>
                          <td className="p-3">
                            <span
                              className={cn(
                                'rounded-full px-2 py-1 text-xs',
                                row.status === 'ACTIVE'
                                  ? 'bg-emerald-500/10 text-emerald-600'
                                  : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {row.status || 'Unknown'}
                            </span>
                          </td>
                          {columns.map((c) => (
                            <td
                              className="p-3 text-right whitespace-nowrap tabular-nums"
                              key={c}
                            >
                              {metric(row, c)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    {!rows.length && (
                      <tr>
                        <td
                          colSpan={columns.length + 2 + (canManage ? 1 : 0)}
                          className="text-muted-foreground p-10 text-center"
                        >
                          No matching campaigns. Sync your account or change the
                          filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {data.documents.some((d) => d.kind === 'draft') && (
                <section>
                  <h2 className="mb-3 font-semibold">Saved drafts</h2>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {data.changes
                      .filter(
                        (c) =>
                          c.connection_id === data.connection?.id &&
                          [
                            'review',
                            'failed',
                            'uncertain',
                            'processing',
                          ].includes(c.status)
                      )
                      .map((c) => (
                        <Button
                          key={c.id}
                          variant="outline"
                          onClick={() => setReview(c)}
                        >
                          Review {c.action} · {c.status}
                        </Button>
                      ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {data.documents
                      .filter(
                        (d) =>
                          d.kind === 'draft' &&
                          d.data.connectionId === data.connection?.id
                      )
                      .map((d) => (
                        <Button
                          key={d.id}
                          variant="outline"
                          disabled={!canManage}
                          onClick={() => setWizard({ existing: d })}
                        >
                          {d.name}
                          <ArrowUpRight size={14} />
                        </Button>
                      ))}
                  </div>
                </section>
              )}
            </>
          )}
          {tab === 'Creative Library' && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  Review offers and creative results before planning a refresh.
                </p>
                {canManage && (
                  <Button onClick={() => openEditor('creative')}>
                    <Plus size={16} />
                    Add creative
                  </Button>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.entities
                  .filter((e) => e.kind === 'ad')
                  .map((e) => {
                    const creative = object(e.data.creative),
                      result = report?.ads.find((r) => r.id === e.meta_id);
                    return (
                      <button
                        key={e.id}
                        className="border-border bg-card overflow-hidden rounded-xl border text-left"
                        onClick={() => setSelected(e)}
                      >
                        {thumbnail(e) ? (
                          <Image
                            src={thumbnail(e)}
                            alt={e.name}
                            width={480}
                            height={300}
                            unoptimized
                            className="aspect-video w-full object-cover"
                          />
                        ) : (
                          <div className="bg-muted aspect-video" />
                        )}
                        <div className="p-4">
                          <h3 className="font-semibold">{e.name}</h3>
                          <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                            {String(creative.body || creative.title || '')}
                          </p>
                          <p className="mt-3 text-sm">
                            {currency(result?.spend || 0, code)} spend ·{' '}
                            {result?.qualified || 0} qualified ·{' '}
                            {result?.customers || 0} customers
                          </p>
                        </div>
                      </button>
                    );
                  })}
                {data.documents
                  .filter((d) => d.kind === 'creative')
                  .map((d) => (
                    <div
                      key={d.id}
                      className="border-border rounded-xl border p-4"
                    >
                      <h3 className="font-semibold">{d.name}</h3>
                      {Boolean(d.data.imageUrl) && (
                        <Image
                          src={String(d.data.imageUrl)}
                          alt={d.name}
                          width={480}
                          height={300}
                          unoptimized
                          className="mt-3 aspect-video w-full rounded-lg object-cover"
                        />
                      )}
                      <p className="text-muted-foreground mt-2 text-sm">
                        {String(d.data.copy || '')}
                      </p>
                      <p className="mt-2 text-xs">
                        Offer / angle: {String(d.data.tags || 'Not tagged')}
                      </p>
                      {canManage && (
                        <Button
                          className="mt-3 mr-2"
                          onClick={() =>
                            setWizard({ existing: null, creative: d })
                          }
                        >
                          Use in campaign
                        </Button>
                      )}
                      {canManage && (
                        <Button
                          variant="outline"
                          className="mt-3"
                          onClick={() => openEditor('creative', d)}
                        >
                          Edit creative
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
            </>
          )}
          {tab === 'Lead Quality' && (
            <LeadQuality
              key={`${data.connection?.id}:${journeyFilter}`}
              data={data}
              refresh={load}
              run={run}
              initialFilter={journeyFilter}
            />
          )}
          {tab === 'Reports' && report && (
            <>
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">
                    Performance and decisions
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    Compare {range.start}–{range.end} with{' '}
                    {data.previous?.start}–{data.previous?.end}.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => exportCampaignCsv(report.campaigns, code)}
                  >
                    <Download size={16} />
                    Export CSV
                  </Button>
                  {canManage && (
                    <Button
                      variant="outline"
                      onClick={() => openEditor('report')}
                    >
                      Save report
                    </Button>
                  )}
                  <a
                    href="/ads/legacy"
                    className="text-primary px-2 py-2 text-sm underline"
                  >
                    Original all-time report
                  </a>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {data.recommendations.map((r) => {
                  const decision = data.documents
                    .filter(
                      (d) =>
                        d.kind === 'decision' &&
                        d.data.recommendationId === r.id &&
                        d.data.start === range.start &&
                        d.data.end === range.end
                    )
                    .at(-1);
                  return (
                    <article
                      key={r.id}
                      className="border-border rounded-xl border p-5"
                    >
                      <span className="text-muted-foreground text-xs">
                        {r.category} · {r.sample} observations · directional
                      </span>
                      <h3 className="mt-1 font-semibold">{r.title}</h3>
                      <p className="mt-2 text-sm">{r.evidence}</p>
                      <p className="text-muted-foreground mt-2 text-sm">
                        {r.action}
                      </p>
                      <p className="text-muted-foreground mt-2 text-xs">
                        Attribution gaps, conversion delay, and small samples
                        can affect this comparison.
                      </p>
                      {canManage && (
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                saveDocument('decision', r.title, {
                                  recommendationId: r.id,
                                  start: range.start,
                                  end: range.end,
                                  status: 'accepted',
                                })
                              )
                            }
                          >
                            Accept for review
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                saveDocument('decision', r.title, {
                                  recommendationId: r.id,
                                  start: range.start,
                                  end: range.end,
                                  status: 'dismissed',
                                })
                              )
                            }
                          >
                            Dismiss
                          </Button>
                          {r.campaignId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setSelected(
                                  data.entities.find(
                                    (e) => e.meta_id === r.campaignId
                                  ) || null
                                )
                              }
                            >
                              Review campaign
                            </Button>
                          )}
                        </div>
                      )}
                      {decision && (
                        <p className="mt-2 text-xs">
                          Decision: {String(decision.data.status)}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
              <section className="border-border rounded-xl border p-5">
                <div className="flex justify-between">
                  <h2 className="font-semibold">Experiments and annotations</h2>
                  {canManage && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEditor('note')}
                      >
                        Add annotation
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => openEditor('experiment')}
                      >
                        Plan experiment
                      </Button>
                    </div>
                  )}
                </div>
                {data.documents
                  .filter((d) => ['experiment', 'note'].includes(d.kind))
                  .map((d) => (
                    <div
                      key={d.id}
                      className="border-border mt-3 border-t pt-3"
                    >
                      <h3 className="text-sm font-medium">{d.name}</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {String(d.data.hypothesis || d.data.note || '')}
                      </p>
                      {d.kind === 'experiment' && (
                        <p className="text-muted-foreground text-xs">
                          Metric: {String(d.data.metric)} · Variants:{' '}
                          {String(d.data.variants)} · {String(d.data.start)}–
                          {String(d.data.end)}. No winner is declared
                          automatically.
                        </p>
                      )}
                    </div>
                  ))}
              </section>
              <section>
                <h2 className="font-semibold">Saved reports</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.documents
                    .filter((d) => d.kind === 'report')
                    .map((d) => (
                      <Button
                        key={d.id}
                        variant="outline"
                        onClick={() => {
                          setConnection(String(d.data.connectionId));
                          const next = {
                            start: String(d.data.start),
                            end: String(d.data.end),
                          };
                          setRange(next);
                          setDates(next);
                        }}
                      >
                        {d.name}
                      </Button>
                    ))}
                </div>
              </section>
            </>
          )}
          {tab === 'Settings' && (
            <WorkspaceSettings data={data} refresh={load} run={run} />
          )}
          {data.coverage && (
            <p className="text-muted-foreground text-xs">
              {data.coverage.start
                ? `Stored Meta coverage begins ${data.coverage.start}. Earlier periods may be incomplete.`
                : 'Meta history is not available until a successful sync.'}
              {data.coverage.contactLimitReached ||
              data.coverage.conversationLimitReached
                ? ' Some CRM data reached the current reporting limit; interpret totals as partial.'
                : ''}
            </p>
          )}
        </>
      )}
      {wizard && data?.connection && (
        <CampaignWizard
          workspace={data}
          existing={wizard.existing}
          creative={wizard.creative}
          onClose={() => {
            setWizard(null);
            void load();
          }}
          onReview={(r) => {
            setWizard(null);
            setReview(r);
          }}
        />
      )}
      {review && (
        <Modal title="Review campaign change" onClose={() => setReview(null)}>
          <ChangeReview
            review={review}
            currency={code}
            busy={busy}
            onApprove={() =>
              run(async () => {
                await adsRequest('/api/ads/actions', {
                  approve: true,
                  requestId: review.id,
                });
                toast.success('Campaign change applied');
                setReview(null);
              })
            }
            onCancel={() =>
              run(async () => {
                await adsRequest('/api/ads/actions', {
                  cancel: true,
                  requestId: review.id,
                });
                setReview(null);
              })
            }
            onReconcile={(remoteId) =>
              run(async () => {
                await adsRequest('/api/ads/actions', {
                  reconcile: true,
                  requestId: review.id,
                  remoteId,
                });
                setReview(null);
                toast.success(
                  'Operation reconciled; open its review to resume'
                );
              })
            }
          />
        </Modal>
      )}
      {bulkReview && (
        <Modal
          title="Review bulk campaign changes"
          onClose={() => setBulkReview(null)}
        >
          <p className="text-sm">
            These changes affect {bulkReview.length} items. Activation can start
            advertising spend. Each result is recorded separately.
          </p>
          <ul className="my-4 space-y-2">
            {bulkReview.map((r) => (
              <li key={r.id} className="rounded border p-3 text-sm">
                {data?.entities.find((e) => e.meta_id === r.entity_id)?.name ||
                  r.entity_id}
                : {String(r.before_data.status)} to{' '}
                {String(r.after_data.status)}
              </li>
            ))}
          </ul>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                let applied = 0;
                for (const r of bulkReview) {
                  try {
                    await adsRequest('/api/ads/actions', {
                      approve: true,
                      requestId: r.id,
                    });
                    applied++;
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }
                toast.success(
                  applied +
                    ' of ' +
                    bulkReview.length +
                    ' changes applied; check activity history for remaining items'
                );
                setBulkReview(null);
                setPicked([]);
              })
            }
          >
            Confirm all reviewed changes
          </Button>
        </Modal>
      )}
      {selected && data && (
        <Modal title={selected.name} onClose={() => setSelected(null)}>
          <p className="text-muted-foreground text-sm">
            {selected.kind} · {selected.status} · {data.connection?.name}
          </p>
          {(() => {
            const row = report?.[
              selected.kind === 'campaign'
                ? 'campaigns'
                : selected.kind === 'adset'
                  ? 'adsets'
                  : 'ads'
            ].find((r) => r.id === selected.meta_id);
            return (
              row && (
                <div className="my-4 grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
                  <span>Selected-period spend</span>
                  <strong>{currency(row.spend, code)}</strong>
                  <span>Current daily budget</span>
                  <strong>{currency(row.dailyBudget, code)}</strong>
                  <span>Budget baseline for this period</span>
                  <strong>{currency(row.budgetBaseline, code)}</strong>
                  <p className="text-muted-foreground col-span-2 text-xs">
                    The baseline uses today’s budget settings across the
                    selected days. It is not a forecast or a spending cap;
                    schedule changes and earlier budget edits can affect pacing.
                  </p>
                </div>
              )
            );
          })()}
          {thumbnail(previewFor(selected.meta_id)) && (
            <Image
              src={thumbnail(previewFor(selected.meta_id))}
              width={500}
              height={300}
              alt="Campaign creative preview"
              unoptimized
              className="mt-4 max-h-64 w-full rounded-lg object-contain"
            />
          )}
          <div className="mt-4 space-y-3">
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {['PAUSED', 'ACTIVE'].map((s) => (
                  <Button
                    variant="outline"
                    disabled={busy}
                    key={s}
                    onClick={() =>
                      run(async () => {
                        const result = await adsRequest<{
                          review: ChangeRecord;
                        }>('/api/ads/actions', {
                          connectionId: data.connection!.id,
                          entityId: selected.meta_id,
                          action: 'status',
                          status: s,
                        });
                        setSelected(null);
                        setReview(result.review);
                      })
                    }
                  >
                    {s === 'ACTIVE' ? 'Review activation' : 'Review pause'}
                  </Button>
                ))}
                {selected.kind === 'campaign' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const result = await adsRequest<{
                          review: ChangeRecord;
                        }>('/api/ads/actions', {
                          connectionId: data.connection!.id,
                          entityId: selected.meta_id,
                          action: 'duplicate',
                        });
                        setSelected(null);
                        setReview(result.review);
                      })
                    }
                  >
                    Duplicate paused
                  </Button>
                )}
                {Boolean(selected.data.daily_budget) && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setForm({ budget: '' });
                      setEditor({ kind: 'budget' });
                    }}
                  >
                    Change daily budget
                  </Button>
                )}
              </div>
            )}
            <CampaignDetailTrend
              connection={data.connection!.id}
              entity={selected.meta_id}
              start={range.start}
              end={range.end}
              currency={code}
            />
            <h3 className="font-semibold">Related leads</h3>
            {data.report?.leads
              .filter((l) =>
                selected.kind === 'ad'
                  ? l.ad_id === selected.meta_id
                  : selected.kind === 'campaign'
                    ? l.campaign_id === selected.meta_id
                    : data.entities.some(
                        (e) =>
                          e.meta_id === l.ad_id &&
                          e.parent_id === selected.meta_id
                      )
              )
              .slice(0, 20)
              .map((l) => (
                <p key={l.id} className="border-border border-b py-2 text-sm">
                  {l.name} · {l.qualification?.status || 'Not qualified yet'}
                </p>
              ))}
            <h3 className="pt-3 font-semibold">Activity history</h3>
            {data.changes
              .filter((c) => c.entity_id === selected.meta_id)
              .map((c) => (
                <button
                  className="block py-2 text-left text-sm underline"
                  key={c.id}
                  onClick={() => {
                    setSelected(null);
                    setReview(c);
                  }}
                >
                  {c.action}: {c.status} ·{' '}
                  {new Date(c.created_at).toLocaleString()}
                </button>
              ))}
          </div>
        </Modal>
      )}
      {editor && data && (
        <Modal
          title={
            editor.kind === 'budget'
              ? 'Review budget adjustment'
              : `Save ${editor.kind}`
          }
          onClose={() => setEditor(null)}
        >
          <div className="space-y-3">
            {(editor.kind === 'budget'
              ? ['budget']
              : editor.kind === 'creative'
                ? ['name', 'copy', 'imageUrl', 'videoId', 'tags']
                : editor.kind === 'experiment'
                  ? ['name', 'hypothesis', 'variants', 'metric', 'start', 'end']
                  : editor.kind === 'note'
                    ? ['name', 'note']
                    : ['name']
            ).map((key) => (
              <label key={key} className="grid gap-1 text-sm">
                {key}
                <input
                  className={fieldClass}
                  type={
                    ['start', 'end'].includes(key)
                      ? 'date'
                      : key === 'budget'
                        ? 'number'
                        : 'text'
                  }
                  value={form[key] || ''}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
            <Button
              disabled={
                busy || (editor.kind !== 'budget' && !form.name?.trim())
              }
              onClick={() =>
                run(async () => {
                  if (editor.kind === 'budget' && selected) {
                    const result = await adsRequest<{ review: ChangeRecord }>(
                      '/api/ads/actions',
                      {
                        action: 'budget',
                        connectionId: data.connection!.id,
                        entityId: selected.meta_id,
                        budget: Number(form.budget),
                      }
                    );
                    setSelected(null);
                    setReview(result.review);
                  } else
                    await saveDocument(
                      editor.kind,
                      form.name,
                      {
                        ...form,
                        ...(editor.kind === 'view'
                          ? {
                              query,
                              status,
                              columns,
                              level,
                              connectionId: data.connection?.id,
                            }
                          : {}),
                        ...(editor.kind === 'report'
                          ? { ...range, connectionId: data.connection?.id }
                          : {}),
                      },
                      editor.existing
                    );
                  setEditor(null);
                })
              }
            >
              {editor.kind === 'budget' ? 'Prepare review' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    panel?.focus();
    return () => old?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-background h-full w-full max-w-2xl overflow-auto p-5 shadow-xl outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab') {
            const nodes = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],textarea'
            );
            if (nodes?.length) {
              const first = nodes[0],
                last = nodes[nodes.length - 1];
              if (
                e.shiftKey &&
                (document.activeElement === first ||
                  document.activeElement === ref.current)
              ) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }
        }}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">{title}</h2>
          <Button variant="ghost" aria-label="Close panel" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
