'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CampaignDraft } from '@/lib/ads/campaign-actions';
import {
  adsRequest,
  fieldClass,
  type WorkspaceData,
  type WorkspaceDocument,
  type ChangeRecord,
} from './workspace-types';

const steps = [
  'Goal and identity',
  'Audience',
  'Budget and schedule',
  'Creative and conversation',
  'Review',
];
export function CampaignWizard({
  workspace,
  existing,
  creative,
  onClose,
  onReview,
}: {
  workspace: WorkspaceData;
  existing: WorkspaceDocument | null;
  creative?: WorkspaceDocument;
  onClose: () => void;
  onReview: (review: ChangeRecord) => void;
}) {
  const [doc, setDoc] = useState(existing);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>('button, input, select, textarea')
      ?.focus();
    return () => previous?.focus();
  }, []);
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<
    { id: string; name: string; whatsapp_number?: string }[]
  >([]);
  const [identityError, setIdentityError] = useState('');
  const [draft, setDraft] = useState<CampaignDraft>(() =>
    existing
      ? (existing.data as unknown as CampaignDraft)
      : {
          connectionId: workspace.connection!.id,
          name: '',
          goal: 'qualified',
          pageId: '',
          whatsapp: '',
          country: '',
          ageMin: 18,
          ageMax: 65,
          dailyBudget: 0,
          start: new Date(Date.now() + 3600_000).toISOString(),
          end: new Date(Date.now() + 7 * 86400_000).toISOString(),
          headline: creative?.name || '',
          message: String(creative?.data.copy || ''),
          openingMessage: '',
          imageUrl: String(creative?.data.imageUrl || ''),
          videoId: String(creative?.data.videoId || ''),
          flowId: '',
          launch: false,
        }
  );
  useEffect(() => {
    let cancelled = false;
    adsRequest<{ pages: typeof pages }>(
      `/api/ads/actions?connection=${draft.connectionId}`
    )
      .then((r) => {
        if (!cancelled) setPages(r.pages);
      })
      .catch((e) => {
        if (!cancelled) setIdentityError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.connectionId]);
  const patch = <K extends keyof CampaignDraft>(
    key: K,
    value: CampaignDraft[K]
  ) => setDraft((d) => ({ ...d, [key]: value }));
  async function save() {
    const result = await adsRequest<{ document: WorkspaceDocument }>(
      '/api/ads/workspace',
      {
        action: 'document',
        kind: 'draft',
        name: draft.name || 'Untitled WhatsApp campaign',
        data: draft,
        id: doc?.id,
        revision: doc?.revision,
      }
    );
    setDoc(result.document);
    return result.document;
  }
  const input = (label: string, key: keyof CampaignDraft, type = 'text') => (
    <label className="grid gap-1 text-sm">
      {label}
      <input
        className={fieldClass}
        type={type}
        value={String(draft[key] ?? '')}
        onChange={(e) =>
          patch(
            key,
            (type === 'number'
              ? Number(e.target.value)
              : e.target.value) as never
          )
        }
      />
    </label>
  );
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Create WhatsApp campaign"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab') {
          const items = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
            ) || []
          ).filter((item) => item.getClientRects().length);
          const first = items[0],
            last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="bg-background flex h-full w-full max-w-4xl flex-col overflow-auto shadow-xl">
        <header className="border-border flex items-center justify-between border-b p-5">
          <div>
            <p className="text-muted-foreground text-sm">WhatsApp campaign</p>
            <h2 className="text-xl font-semibold">
              {existing ? 'Resume draft' : 'Create campaign'}
            </h2>
          </div>
          <Button
            variant="ghost"
            aria-label="Close campaign wizard"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <ol className="border-border flex flex-wrap gap-3 border-b px-5 py-4">
          {steps.map((s, i) => (
            <li key={s}>
              <button
                onClick={() => setStep(i)}
                aria-current={i === step ? 'step' : undefined}
                className={
                  i === step
                    ? 'text-primary font-semibold'
                    : 'text-muted-foreground'
                }
              >
                {i + 1}. {s}
              </button>
            </li>
          ))}
        </ol>
        <div className="grid flex-1 gap-6 p-5 md:grid-cols-[1fr_250px]">
          <div className="space-y-4">
            {step === 0 && (
              <>
                {input('Campaign name', 'name')}
                <label className="grid gap-1 text-sm">
                  Primary business outcome
                  <select
                    className={fieldClass}
                    value={draft.goal}
                    onChange={(e) =>
                      patch('goal', e.target.value as 'qualified' | 'sales')
                    }
                  >
                    <option value="qualified">Qualified leads</option>
                    <option value="sales">Sales</option>
                  </select>
                </label>
                <p className="text-muted-foreground text-xs">
                  The initial campaign uses Meta’s conversation optimization.
                  Your business outcome drives reporting; it does not silently
                  change Meta’s optimization goal.
                </p>
                <label className="grid gap-1 text-sm">
                  Facebook Page
                  <select
                    className={fieldClass}
                    value={draft.pageId}
                    onChange={(e) => {
                      patch('pageId', e.target.value);
                      patch(
                        'whatsapp',
                        pages.find((p) => p.id === e.target.value)
                          ?.whatsapp_number || ''
                      );
                    }}
                  >
                    <option value="">Choose a Page</option>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.whatsapp_number
                          ? ` · ${p.whatsapp_number}`
                          : ' · link WhatsApp in Meta'}
                      </option>
                    ))}
                  </select>
                </label>
                {identityError && (
                  <p role="alert" className="text-destructive text-sm">
                    {identityError}
                  </p>
                )}
                {input('Linked WhatsApp number', 'whatsapp')}
                <p className="text-muted-foreground text-xs">
                  Publishing checks the Page’s linked WhatsApp number. Use Meta
                  to complete the Page connection if it is missing.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                {input('Country code, for example IN', 'country')}
                <div className="grid grid-cols-2 gap-3">
                  {input('Minimum age', 'ageMin', 'number')}
                  {input('Maximum age', 'ageMax', 'number')}
                </div>
                <p className="text-muted-foreground text-sm">
                  Automatic placements are used. Regulated-category campaigns
                  require additional controls and should be created in Meta.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                {input(
                  `Daily budget (${workspace.connection?.currency})`,
                  'dailyBudget',
                  'number'
                )}
                <label className="grid gap-1 text-sm">
                  Start (your browser timezone)
                  <input
                    type="datetime-local"
                    className={fieldClass}
                    value={localDate(draft.start)}
                    onChange={(e) => {
                      if (e.target.value)
                        patch('start', new Date(e.target.value).toISOString());
                    }}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  End (your browser timezone)
                  <input
                    type="datetime-local"
                    className={fieldClass}
                    value={localDate(draft.end)}
                    onChange={(e) => {
                      if (e.target.value)
                        patch('end', new Date(e.target.value).toISOString());
                    }}
                  />
                </label>
                <p className="text-muted-foreground text-xs">
                  The account timezone is {workspace.connection?.timezone}.
                  Daily budgets are pacing settings, rather than a guaranteed
                  daily invoice amount.
                </p>
              </>
            )}
            {step === 3 && (
              <>
                {input('Headline', 'headline')}
                <label className="grid gap-1 text-sm">
                  Ad text
                  <textarea
                    className={fieldClass}
                    rows={3}
                    value={draft.message}
                    onChange={(e) => patch('message', e.target.value)}
                  />
                </label>
                {input('Public HTTPS image or video thumbnail URL', 'imageUrl')}
                {input('Existing Meta video ID (optional)', 'videoId')}
                {input('Opening customer message', 'openingMessage')}
                <label className="grid gap-1 text-sm">
                  Qualification flow
                  <select
                    value={draft.flowId}
                    className={fieldClass}
                    onChange={(e) => patch('flowId', e.target.value)}
                  >
                    <option value="">No linked flow</option>
                    {workspace.flows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-muted-foreground text-xs">
                  Use an existing Meta video ID for video ads. Linked flows
                  start when a message includes this ad’s referral.
                </p>
              </>
            )}
            {step === 4 && (
              <>
                <h3 className="text-lg font-semibold">Review your campaign</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <dt>Name</dt>
                  <dd>{draft.name || 'Missing'}</dd>
                  <dt>Business outcome</dt>
                  <dd>{draft.goal}</dd>
                  <dt>Account</dt>
                  <dd>{workspace.connection?.name}</dd>
                  <dt>Budget</dt>
                  <dd>
                    {draft.dailyBudget} {workspace.connection?.currency} / day
                  </dd>
                  <dt>Audience</dt>
                  <dd>
                    {draft.country}, {draft.ageMin}–{draft.ageMax}
                  </dd>
                  <dt>WhatsApp</dt>
                  <dd>{draft.whatsapp || 'Missing'}</dd>
                  <dt>Schedule</dt>
                  <dd>
                    {new Date(draft.start).toLocaleString()} –{' '}
                    {new Date(draft.end).toLocaleString()}
                  </dd>
                </dl>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.launch}
                    onChange={(e) => patch('launch', e.target.checked)}
                  />
                  Activate after publishing. This can start advertising spend
                  after Meta approval.
                </label>
                <p className="text-muted-foreground text-sm">
                  Leave activation unchecked to create the campaign paused. The
                  next screen shows the final publish review.
                </p>
              </>
            )}
          </div>
          <aside className="self-start rounded-xl border p-3">
            <p className="text-muted-foreground mb-3 text-xs">
              Illustrative feed preview
            </p>
            <p className="text-sm font-semibold">
              {pages.find((p) => p.id === draft.pageId)?.name ||
                'Your business'}
            </p>
            <p className="my-2 text-sm whitespace-pre-wrap">
              {draft.message || 'Your ad text appears here.'}
            </p>
            {/^https:\/\//.test(draft.imageUrl) ? (
              <Image
                src={draft.imageUrl}
                alt="Ad creative preview"
                width={240}
                height={240}
                unoptimized
                className="aspect-square w-full rounded-lg object-cover"
              />
            ) : (
              <div className="bg-muted flex aspect-square items-center justify-center rounded-lg text-sm">
                Creative preview
              </div>
            )}
            <p className="mt-3 font-medium">
              {draft.headline || 'Your headline'}
            </p>
            <p className="text-primary mt-2 text-sm">Send WhatsApp message</p>
            <p className="text-muted-foreground mt-3 text-xs">
              Meta determines final rendering and supported placements.
            </p>
          </aside>
        </div>
        <footer className="border-border flex flex-wrap justify-between gap-2 border-t p-5">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await save();
                toast.success('Draft saved');
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save draft
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={!step || busy}
              onClick={() => setStep(step - 1)}
            >
              <ChevronLeft />
              Back
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (step < 4) {
                  setStep(step + 1);
                  return;
                }
                setBusy(true);
                try {
                  const saved = await save();
                  const result = await adsRequest<{ review: ChangeRecord }>(
                    '/api/ads/actions',
                    {
                      action: 'publish',
                      connectionId: draft.connectionId,
                      draftId: saved.id,
                    }
                  );
                  onReview(result.review);
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? 'Checking…'
                : step < 4
                  ? 'Continue'
                  : 'Prepare publish review'}
              <ChevronRight />
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
function localDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
