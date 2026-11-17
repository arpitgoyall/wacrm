'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ScopeOption {
  id: string;
  description: string;
  checked: boolean;
}

interface Props {
  clientName: string;
  redirectHost: string;
  accountName: string;
  request: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    state: string | null;
  };
  scopes: ScopeOption[];
}

export function ConsentForm({
  clientName,
  redirectHost,
  accountName,
  request,
  scopes,
}: Props) {
  const [selected, setSelected] = useState<string[]>(
    scopes.filter((s) => s.checked).map((s) => s.id)
  );
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]
    );

  async function submit(decision: 'approve' | 'deny') {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          state: request.state ?? undefined,
          decision,
          scopes: selected,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        redirect?: string;
        error?: string;
      };
      if (!res.ok || !data.redirect) {
        setError(data.error ?? 'Something went wrong. Please try again.');
        setBusy(null);
        return;
      }
      window.location.href = data.redirect;
    } catch {
      setError('Network error. Please try again.');
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
          <ShieldCheck className="text-primary h-5 w-5" />
        </div>
        <div>
          <h1 className="text-foreground text-lg font-semibold">
            Connect {clientName} to {accountName}?
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            You&apos;ll be sent back to{' '}
            <span className="font-medium">{redirectHost}</span> after you
            choose. Only approve apps you trust.
          </p>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-foreground mb-1 text-sm font-medium">
          Allow this app to:
        </legend>
        {scopes.map((s) => (
          <label
            key={s.id}
            className="border-border flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm"
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={selected.includes(s.id)}
              onChange={() => toggle(s.id)}
            />
            <span>
              <span className="text-foreground">{s.description}</span>
              <span className="text-muted-foreground block text-xs">
                {s.id}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="text-muted-foreground text-xs">
        You can revoke access any time in Settings → API keys (it appears as
        &ldquo;OAuth: {clientName}&rdquo;).
      </p>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => submit('deny')}
        >
          {busy === 'deny' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Deny
        </Button>
        <Button
          className="flex-1"
          disabled={busy !== null || selected.length === 0}
          onClick={() => submit('approve')}
        >
          {busy === 'approve' && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          Approve
        </Button>
      </div>
    </div>
  );
}
