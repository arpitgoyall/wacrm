'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { BusinessRules, QualificationRule } from '@/lib/ads/outcomes';
import { adsRequest, fieldClass, type WorkspaceData } from './workspace-types';

export function WorkspaceSettings({
  data,
  run,
}: {
  data: WorkspaceData;
  refresh: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = ['admin', 'owner'].includes(data.role);
  const definition = data.documents.filter((d) => d.kind === 'rules').at(-1);
  const [rules, setRules] = useState<BusinessRules>(
    () =>
      (definition?.data as BusinessRules) || {
        enabled: false,
        qualifiedStages: [],
        saleStages: [],
        rules: [],
        match: 'all',
      }
  );
  const [token, setToken] = useState(''),
    [session, setSession] = useState(''),
    [oauthReady, setOauthReady] = useState(false);
  const [available, setAvailable] = useState<
      { id: string; name: string; currency: string }[]
    >([]),
    [method, setMethod] = useState<'token' | 'legacy' | 'oauth'>('oauth');
  const [integration, setIntegration] = useState('');
  useEffect(() => {
    const id =
      new URLSearchParams(window.location.search).get('connect_session') || '';
    adsRequest<{ available: typeof available; oauthReady: boolean }>(
      `/api/ads/connections${id ? `?session=${id}` : ''}`
    )
      .then((r) => {
        setSession(id);
        setAvailable(r.available);
        setOauthReady(r.oauthReady);
      })
      .catch((e) => toast.error(e.message));
  }, []);
  return (
    <div className="space-y-5">
      <section className="border-border bg-card rounded-xl border p-5">
        <h2 className="font-semibold">Connected ad accounts</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Each account keeps its own reporting currency and timezone.
        </p>
        <div className="mt-4 divide-y">
          {data.connections.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="font-medium">{c.name}</p>
                <p className="text-muted-foreground text-xs">
                  {c.meta_account_id} · {c.currency} · {c.timezone} ·{' '}
                  {c.permissions.includes('ads_management')
                    ? 'Read and manage'
                    : 'Read only'}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {c.history_start
                    ? `History checked from ${c.history_start}`
                    : 'Awaiting first sync'}
                  {c.sync_claimed_at ? ' · Sync in progress' : ''}
                </p>
                {c.error && (
                  <p className="mt-1 text-xs text-amber-600">{c.error}</p>
                )}
              </div>
              {admin && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      run(() =>
                        adsRequest('/api/ads/connections', {
                          action: 'sync',
                          connectionId: c.id,
                        })
                      )
                    }
                  >
                    Sync
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      run(() =>
                        adsRequest('/api/ads/connections', {
                          action: 'backfill',
                          connectionId: c.id,
                        })
                      )
                    }
                  >
                    Backfill next 7 days
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
      {admin && (
        <section className="border-border rounded-xl border p-5">
          <h2 className="font-semibold">Connect or reconnect Meta</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Select accounts your Meta login can access. Reconnecting updates the
            existing connection.
          </p>
          <div className="my-4 flex flex-wrap gap-2">
            <Button
              disabled={!oauthReady}
              onClick={() => {
                window.location.href = '/api/ads/oauth';
              }}
            >
              Connect with Meta
            </Button>
            <Button variant="outline" onClick={() => setMethod('token')}>
              Use an access token
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                run(async () => {
                  const result = await adsRequest<{
                    available: typeof available;
                  }>('/api/ads/connections', { action: 'legacy' });
                  setAvailable(result.available);
                  setMethod('legacy');
                })
              }
            >
              Use saved WhatsApp ad connection
            </Button>
          </div>
          {!oauthReady && (
            <p className="text-muted-foreground text-xs">
              Meta login needs the application ID, secret, public app URL, and
              approved permissions configured by the administrator. Existing
              access tokens remain supported.
            </p>
          )}
          {method === 'token' && (
            <div className="mt-3 flex gap-2">
              <input
                className={fieldClass}
                type="password"
                autoComplete="off"
                aria-label="Meta access token"
                placeholder="Meta access token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button
                onClick={() =>
                  run(async () => {
                    const result = await adsRequest<{
                      available: typeof available;
                    }>('/api/ads/connections', { token });
                    setAvailable(result.available);
                  })
                }
              >
                Find accounts
              </Button>
            </div>
          )}
          {available.length > 0 && (
            <div className="mt-4 space-y-2">
              {available.map((a) => (
                <div
                  className="flex items-center justify-between rounded-lg border p-3"
                  key={a.id}
                >
                  <span className="text-sm">
                    {a.name} · {a.currency}
                  </span>
                  <Button
                    size="sm"
                    onClick={() =>
                      run(async () => {
                        await adsRequest('/api/ads/connections', {
                          metaAccountId: a.id,
                          ...(method === 'legacy'
                            ? { action: 'legacy' }
                            : session && method === 'oauth'
                              ? { session }
                              : { token }),
                        });
                        toast.success('Ad account connected');
                      })
                    }
                  >
                    Connect account
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <section className="border-border rounded-xl border p-5">
        <h2 className="font-semibold">
          Business qualification and conversion rules
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Rules apply prospectively to new and subsequently updated contacts.
          Staff overrides take precedence. Saving rules does not re-evaluate
          historical contacts.
        </p>
        <fieldset
          disabled={!admin}
          className="mt-4 space-y-4 disabled:opacity-60"
        >
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(rules.enabled)}
              onChange={(e) =>
                setRules({ ...rules, enabled: e.target.checked })
              }
            />
            Enable qualification rules and pipeline outcome mappings
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium">
                Moving into these stages qualifies a lead
              </h3>
              {data.stages.map((s) => (
                <label className="mb-2 flex gap-2 text-sm" key={s.id}>
                  <input
                    type="checkbox"
                    checked={rules.qualifiedStages?.includes(s.id) || false}
                    onChange={(e) =>
                      setRules({
                        ...rules,
                        qualifiedStages: e.target.checked
                          ? [...(rules.qualifiedStages || []), s.id]
                          : (rules.qualifiedStages || []).filter(
                              (id) => id !== s.id
                            ),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">
                Moving into these stages confirms a staff-reported sale
              </h3>
              <p className="text-muted-foreground mb-2 text-xs">
                Only select stages that mean an actual sale. Purchase feedback
                uses the deal value and currency.
              </p>
              {data.stages.map((s) => (
                <label className="mb-2 flex gap-2 text-sm" key={s.id}>
                  <input
                    type="checkbox"
                    checked={rules.saleStages?.includes(s.id) || false}
                    onChange={(e) =>
                      setRules({
                        ...rules,
                        saleStages: e.target.checked
                          ? [...(rules.saleStages || []), s.id]
                          : (rules.saleStages || []).filter(
                              (id) => id !== s.id
                            ),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            Qualification conditions
            <select
              className={fieldClass}
              value={rules.match || 'all'}
              onChange={(e) =>
                setRules({ ...rules, match: e.target.value as 'all' | 'any' })
              }
            >
              <option value="all">All conditions must match</option>
              <option value="any">Any condition can match</option>
            </select>
          </label>
          {(rules.rules || []).map((rule, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2"
            >
              <select
                aria-label="Rule source"
                className={fieldClass}
                value={rule.source}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    rules: rules.rules!.map((r, j) =>
                      j === i
                        ? {
                            ...r,
                            source: e.target
                              .value as QualificationRule['source'],
                          }
                        : r
                    ),
                  })
                }
              >
                <option value="contact">Contact field</option>
                <option value="answer">Chatbot answer</option>
                <option value="stage">Pipeline stage ID</option>
              </select>
              <input
                aria-label="Field or chatbot answer key"
                className={fieldClass}
                value={rule.field}
                placeholder="Field name, custom field ID, or answer key"
                onChange={(e) =>
                  setRules({
                    ...rules,
                    rules: rules.rules!.map((r, j) =>
                      j === i ? { ...r, field: e.target.value } : r
                    ),
                  })
                }
              />
              <select
                aria-label="Rule condition"
                className={fieldClass}
                value={rule.operator}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    rules: rules.rules!.map((r, j) =>
                      j === i
                        ? {
                            ...r,
                            operator: e.target
                              .value as QualificationRule['operator'],
                          }
                        : r
                    ),
                  })
                }
              >
                <option value="equals">Equals</option>
                <option value="contains">Contains</option>
                <option value="gte">At least</option>
                <option value="exists">Is present</option>
              </select>
              <input
                aria-label="Rule value"
                className={fieldClass}
                value={rule.value}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    rules: rules.rules!.map((r, j) =>
                      j === i ? { ...r, value: e.target.value } : r
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRules({
                    ...rules,
                    rules: rules.rules!.filter((_, j) => j !== i),
                  })
                }
              >
                Remove condition
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              setRules({
                ...rules,
                rules: [
                  ...(rules.rules || []),
                  {
                    source: 'answer',
                    field: '',
                    operator: 'equals',
                    value: '',
                  },
                ],
              })
            }
          >
            Add condition
          </Button>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                run(async () => {
                  await adsRequest('/api/ads/workspace', {
                    action: 'document',
                    kind: 'rules',
                    name: 'Business qualification rules',
                    data: rules,
                    id: definition?.id,
                    revision: definition?.revision,
                  });
                  toast.success('Business rules saved');
                })
              }
            >
              Save business rules
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                run(() =>
                  adsRequest('/api/ads/workspace', { action: 'evaluate' })
                )
              }
            >
              Evaluate queued leads
            </Button>
          </div>
        </fieldset>
      </section>
      <section className="border-border rounded-xl border p-5">
        <h2 className="font-semibold">Payment and order confirmations</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your payment integration can confirm or refund a deal through the
          authenticated confirmation endpoint. Staff and payment confirmations
          of the same deal count as one sale.
        </p>
        {admin && (
          <Button
            variant="outline"
            className="mt-3"
            onClick={() =>
              run(async () => {
                const result = await adsRequest<{ key: string }>(
                  '/api/ads/workspace',
                  { action: 'integration-key' }
                );
                setIntegration(result.key);
              })
            }
          >
            Generate or rotate integration key
          </Button>
        )}
        {integration && (
          <div className="mt-3 rounded-lg border p-3">
            <p className="text-xs">
              Copy this key now. It will not be shown again.
            </p>
            <input
              aria-label="Payment integration key"
              readOnly
              type="password"
              className={fieldClass}
              value={integration}
            />
            <Button
              className="mt-2"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(integration);
                toast.success('Integration key copied');
              }}
            >
              Copy key
            </Button>
          </div>
        )}
        <p className="text-muted-foreground mt-3 text-xs">
          Configure your WhatsApp dataset and CAPI credentials in the main
          WhatsApp settings.
        </p>
        <a
          href="/settings"
          className="text-primary mt-2 inline-block text-sm underline"
        >
          Open WhatsApp settings
        </a>
      </section>
      <section className="border-border rounded-xl border p-5">
        <h2 className="font-semibold">Recent campaign changes</h2>
        {data.changes.slice(0, 20).map((c) => (
          <div key={c.id} className="border-border mt-3 border-t pt-3 text-sm">
            <p>
              {c.action} · {c.status} ·{' '}
              {new Date(c.created_at).toLocaleString()}
            </p>
            {c.error && (
              <p className="mt-1 text-xs text-amber-600">{c.error}</p>
            )}
            {c.status === 'uncertain' && (
              <p className="text-muted-foreground text-xs">
                Check the created objects in Meta before continuing. The
                recorded remote IDs are retained for reconciliation.
              </p>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
