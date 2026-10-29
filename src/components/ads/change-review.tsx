'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatAdMoney as formatCurrency } from '@/lib/ads/workspace-report';
import { moneyScale } from '@/lib/ads/workspace-report';
import { object, fieldClass, type ChangeRecord } from './workspace-types';
export function ChangeReview({
  review,
  currency,
  busy,
  onApprove,
  onCancel,
  onReconcile,
}: {
  review: ChangeRecord;
  currency: string;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onReconcile: (id: string) => void;
}) {
  const [remoteId, setRemoteId] = useState('');
  const d = object(review.after_data.draft);
  const terminal = ['applied', 'cancelled'].includes(review.status);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Check the destination, budget and delivery setting before sending this
        change to Meta.
      </p>
      {review.action === 'publish' ? (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt>Campaign</dt>
          <dd>{String(d.name)}</dd>
          <dt>Business goal</dt>
          <dd>{String(d.goal)}</dd>
          <dt>WhatsApp destination</dt>
          <dd>{String(d.whatsapp)}</dd>
          <dt>Audience</dt>
          <dd>
            {String(d.country)}, ages {String(d.ageMin)}–{String(d.ageMax)}
          </dd>
          <dt>Daily budget</dt>
          <dd>{formatCurrency(Number(d.dailyBudget), currency)}</dd>
          <dt>Schedule</dt>
          <dd>
            {String(d.start)} – {String(d.end)}
          </dd>
          <dt>After publishing</dt>
          <dd className="font-semibold">
            {d.launch
              ? 'Activate campaign; advertising spend may begin after Meta approval'
              : 'Keep campaign paused'}
          </dd>
        </dl>
      ) : review.action === 'budget' ? (
        <p className="text-sm">
          Daily budget:{' '}
          <strong>
            {formatCurrency(
              Number(review.before_data.daily_budget) / moneyScale(currency),
              currency
            )}
          </strong>{' '}
          to{' '}
          <strong>
            {formatCurrency(
              Number(review.after_data.daily_budget) / moneyScale(currency),
              currency
            )}
          </strong>
          . Increasing a budget can increase advertising spend.
        </p>
      ) : review.action === 'status' ? (
        <p className="text-sm">
          Delivery: <strong>{String(review.before_data.status)}</strong> to{' '}
          <strong>{String(review.after_data.status)}</strong>.{' '}
          {review.after_data.status === 'ACTIVE'
            ? 'Activation can resume advertising spend.'
            : 'Pausing requests that Meta stop delivery.'}
        </p>
      ) : (
        <p className="text-sm">
          Create a copy of this campaign and its ad sets. The copy starts
          paused.
        </p>
      )}
      <p className="text-sm">
        Review status: <strong>{review.status}</strong>
      </p>
      {review.error && (
        <p role="alert" className="text-sm text-amber-600">
          {review.error}
        </p>
      )}
      {Object.keys(review.remote_ids).length > 0 && (
        <details>
          <summary className="text-sm">Recorded Meta objects</summary>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            {Object.entries(review.remote_ids)
              .filter(([, v]) => typeof v === 'string')
              .map(([key, value]) => (
                <div className="contents" key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
          </dl>
        </details>
      )}
      {['uncertain', 'processing'].includes(review.status) ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm">
            Check Meta for the object created during the interrupted step.
            Reconciliation verifies the account and parent before allowing a
            resume. Processing operations must be at least five minutes old.
          </p>
          <input
            className={fieldClass}
            aria-label="Created Meta object ID"
            value={remoteId}
            onChange={(e) => setRemoteId(e.target.value)}
            placeholder="Created Meta object ID, if requested"
          />
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => onReconcile(remoteId)}
          >
            Reconcile operation
          </Button>
        </div>
      ) : (
        !terminal && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onApprove}>
              {busy
                ? 'Applying…'
                : review.action === 'publish'
                  ? 'Confirm publish settings'
                  : 'Confirm change'}
            </Button>
            <Button variant="outline" disabled={busy} onClick={onCancel}>
              Cancel review
            </Button>
          </div>
        )
      )}
    </div>
  );
}
