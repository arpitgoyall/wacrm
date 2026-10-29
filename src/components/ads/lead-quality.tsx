'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatAdMoney as formatCurrency } from '@/lib/ads/workspace-report';
import { adsRequest, fieldClass, type WorkspaceData } from './workspace-types';

export function LeadQuality({
  data,
  run,
  initialFilter = 'all',
}: {
  data: WorkspaceData;
  refresh: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  initialFilter?: string;
}) {
  const [filter, setFilter] = useState(initialFilter),
    [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [qualification, setQualification] = useState('qualified');
  const [dealId, setDealId] = useState(''),
    [amount, setAmount] = useState(''),
    [saleCurrency, setSaleCurrency] = useState(data.connection?.currency || '');
  const allowed =
      ['owner', 'admin'].includes(data.role) ||
      (data.role === 'agent' && data.teamType === 'sales'),
    admin = ['owner', 'admin'].includes(data.role);
  const report = data.report,
    contact = report?.leads.find((l) => l.id === selected);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          [
            'Median first human reply',
            report?.conversations.medianHumanMinutes == null
              ? '—'
              : `${report.conversations.medianHumanMinutes.toFixed(1)} min`,
          ],
          ['No human reply', report?.conversations.unanswered || 0],
          [
            'Bot-assisted conversations',
            report?.conversations.botAssisted || 0,
          ],
          ['Awaiting follow-up', report?.conversations.awaitingReply || 0],
        ].map(([label, value]) => (
          <div key={label} className="border-border rounded-xl border p-4">
            <p className="text-muted-foreground text-xs">{label}</p>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Human reply time excludes bot messages. Awaiting follow-up means an open
        conversation whose last message is from the customer; it does not imply
        a scheduled task is overdue.
      </p>
      <section className="border-border rounded-xl border p-4">
        <h2 className="mb-3 font-semibold">Qualification flow completion</h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          {[
            ['Started', report?.flowMetrics.started || 0],
            ['Completed', report?.flowMetrics.completed || 0],
            ['Timed out', report?.flowMetrics.timedOut || 0],
            ['Follow-up attempts', report?.flowMetrics.followUpAttempts || 0],
          ].map(([label, value]) => (
            <div key={label} className="bg-muted/40 rounded-lg p-3">
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="mt-1 text-xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
        {Boolean(report?.flowMetrics.dropOffs.length) && (
          <details className="mb-5">
            <summary className="text-sm">Inspect timed-out flow steps</summary>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {report?.flowMetrics.dropOffs.map((f, i) => (
                <li key={i}>
                  {data.flows.find((flow) => flow.id === f.flowId)?.name ||
                    'Qualification flow'}{' '}
                  · Step {f.node || 'unknown'}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="font-semibold">Ad-sourced leads and outcomes</h2>
          <select
            aria-label="Lead quality filter"
            className={fieldClass + ' max-w-48'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All linked leads</option>
            <option value="acquired">Acquired in period</option>
            <option value="answered">Human answered in cohort</option>
            <option value="engaged">Engaged in cohort</option>
            <option value="qualifiedPeriod">Qualified in period</option>
            <option value="customers">Customers in period</option>
            <option value="qualified">Qualified</option>
            <option value="unqualified">Unqualified</option>
            <option value="unknown">Not reviewed</option>
          </select>
        </div>
        <div className="mt-4 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="p-2 font-medium">Lead</th>
                <th className="p-2 font-medium">Qualification</th>
                <th className="p-2 font-medium">Reason</th>
                <th className="p-2 font-medium">Acquired</th>
              </tr>
            </thead>
            <tbody>
              {report?.leads
                .filter(
                  (l) =>
                    filter === 'all' ||
                    (filter === 'acquired' &&
                      report.journey.acquired.includes(l.id)) ||
                    (filter === 'qualifiedPeriod' &&
                      report.journey.qualified.includes(l.id)) ||
                    (filter === 'customers' &&
                      report.journey.customers.includes(l.id)) ||
                    (filter === 'answered' &&
                      report.conversations.answeredContactIds.includes(l.id)) ||
                    (filter === 'engaged' &&
                      report.conversations.engagedContactIds.includes(l.id)) ||
                    (filter === 'unknown'
                      ? !l.qualification
                      : l.qualification?.status === filter)
                )
                .map((l) => (
                  <tr key={l.id} className="border-border border-t">
                    <td className="p-2">
                      <button
                        className="text-primary underline"
                        onClick={() => {
                          setSelected(l.id);
                          setReason('');
                          setDealId('');
                        }}
                      >
                        {l.name || 'Unnamed contact'}
                      </button>
                    </td>
                    <td className="p-2">
                      {l.qualification?.status || 'Not reviewed'}
                    </td>
                    <td className="p-2">{l.qualification?.reason || '—'}</td>
                    <td className="p-2">
                      {new Date(l.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Includes linked leads acquired before the reporting period so their
          current outcomes remain accessible.
        </p>
      </section>
      {contact && (
        <section className="border-primary/30 rounded-xl border p-5">
          <h2 className="font-semibold">{contact.name}</h2>
          <div className="mt-3 grid gap-5 lg:grid-cols-2">
            <fieldset disabled={!allowed} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">
                Staff qualification override
              </legend>
              <select
                className={fieldClass}
                aria-label="Qualification result"
                value={qualification}
                onChange={(e) => setQualification(e.target.value)}
              >
                <option value="qualified">Qualified</option>
                <option value="unqualified">Unqualified</option>
              </select>
              <textarea
                aria-label="Qualification reason"
                className={fieldClass}
                placeholder="Explain the result"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                disabled={!reason.trim()}
                onClick={() =>
                  run(async () => {
                    await adsRequest('/api/ads/workspace', {
                      action: 'qualification',
                      contactId: selected,
                      status: qualification,
                      reason,
                    });
                    toast.success('Qualification saved');
                  })
                }
              >
                Save qualification
              </Button>
            </fieldset>
            <fieldset disabled={!allowed} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">
                Staff-confirmed sale
              </legend>
              <select
                aria-label="Sale deal"
                className={fieldClass}
                value={dealId}
                onChange={(e) => {
                  setDealId(e.target.value);
                  const deal = data.deals.find((d) => d.id === e.target.value);
                  setAmount(String(deal?.value || 0));
                  setSaleCurrency(
                    deal?.currency || data.connection?.currency || ''
                  );
                }}
              >
                <option value="">Select this contact’s deal</option>
                {data.deals
                  .filter((d) => d.contact_id === selected)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
              </select>
              <input
                aria-label="Sale amount"
                type="number"
                min="0"
                className={fieldClass}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <input
                aria-label="Sale currency"
                className={fieldClass}
                value={saleCurrency}
                onChange={(e) => setSaleCurrency(e.target.value.toUpperCase())}
              />
              <Button
                disabled={
                  !dealId ||
                  !Number.isFinite(Number(amount)) ||
                  Number(amount) < 0
                }
                onClick={() =>
                  run(async () => {
                    await adsRequest('/api/ads/workspace', {
                      action: 'sale',
                      contactId: selected,
                      dealId,
                      value: Number(amount),
                      currency: saleCurrency,
                      status: 'confirmed',
                    });
                    toast.success('Sale confirmed');
                  })
                }
              >
                Confirm sale
              </Button>
            </fieldset>
          </div>
          <div className="mt-4">
            {data.sales
              ?.filter((s) => s.contact_id === selected)
              .map((s) => (
                <div
                  className="flex flex-wrap justify-between gap-2 border-t py-3 text-sm"
                  key={s.id}
                >
                  <span>
                    {formatCurrency(s.value, s.currency)} ·{' '}
                    {s.source === 'payment'
                      ? 'Integration-confirmed'
                      : 'Staff-confirmed'}{' '}
                    · {s.status}
                  </span>
                  {allowed &&
                    s.source === 'staff' &&
                    s.status === 'confirmed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          run(() =>
                            adsRequest('/api/ads/workspace', {
                              action: 'sale',
                              contactId: selected,
                              dealId: s.deal_id,
                              value: Number(s.value),
                              currency: s.currency,
                              status: 'refunded',
                            })
                          )
                        }
                      >
                        Record refund
                      </Button>
                    )}
                </div>
              ))}
          </div>
        </section>
      )}
      <section className="border-border rounded-xl border p-5">
        <h2 className="font-semibold">Meta feedback health</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Delivered means Meta acknowledged receiving the event. It does not
          mean an ad was credited or performance improved.
        </p>
        <div className="my-4 flex flex-wrap gap-3">
          <span className="bg-muted rounded-lg px-3 py-2 text-sm">
            Retried: {data.events.filter((e) => e.attempt_count > 1).length}
          </span>
          <span className="bg-muted rounded-lg px-3 py-2 text-sm">
            Duplicate-suppressed:{' '}
            {data.events.reduce(
              (sum, e) => sum + (e.duplicate_suppressed_count || 0),
              0
            )}
          </span>
          {['pending', 'processing', 'delivered', 'failed', 'skipped'].map(
            (status) => (
              <span
                className="bg-muted rounded-lg px-3 py-2 text-sm"
                key={status}
              >
                {status}:{' '}
                {data.events.filter((e) => e.status === status).length}
              </span>
            )
          )}
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="p-2">Event</th>
                <th className="p-2">Delivery</th>
                <th className="p-2">Attempts</th>
                <th className="p-2">Details</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id} className="border-border border-t">
                  <td className="p-2">
                    {e.event_name}
                    <span className="text-muted-foreground block text-xs">
                      {new Date(e.occurred_at).toLocaleString()}
                    </span>
                  </td>
                  <td className="p-2">{e.status}</td>
                  <td className="p-2">{e.attempt_count}</td>
                  <td className="p-2">{e.reason || '—'}</td>
                  <td className="p-2">
                    {admin && ['failed', 'skipped'].includes(e.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            adsRequest('/api/ads/workspace', {
                              action: 'retry',
                              eventId: e.id,
                            })
                          )
                        }
                      >
                        Queue retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Shows the 200 most recent workspace events. Stable event identifiers
          suppress repeated qualification and sale submissions. Refunds remain
          in CRM reporting; they do not manufacture new Purchase events.
        </p>
      </section>
    </div>
  );
}
