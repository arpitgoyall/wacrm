// ============================================================
// /oauth/authorize — consent screen for connecting an AI client
// (Claude.ai, ChatGPT, …) to this wacrm account.
//
// Flow: the client sends the browser here with its PKCE challenge.
// Signed-out visitors are bounced through /login and returned here.
// Only admin+ may approve (same bar as creating an API key). The
// approver picks which permissions to grant; the client never gets
// more than they tick.
//
// Invalid client_id / redirect_uri are shown here and NEVER redirected
// to the client (an open redirect otherwise).
// ============================================================

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import {
  ForbiddenError,
  UnauthorizedError,
  getCurrentAccount,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { validateAuthorizeRequest } from '@/lib/oauth/authorize';
import {
  DEFAULT_OAUTH_SCOPES,
  OAUTH_SCOPES,
  parseRequestedScopes,
} from '@/lib/oauth/core';
import { SCOPE_DESCRIPTIONS } from '@/lib/api-keys/scopes';
import { ConsentForm } from './consent-form';

export const metadata: Metadata = {
  title: 'Connect an app',
  robots: { index: false },
  referrer: 'no-referrer',
};

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <div className="border-border bg-card w-full max-w-md rounded-xl border p-6 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <h1 className="text-foreground text-lg font-semibold">{title}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{body}</p>
    </Shell>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = {
    client_id: first(sp.client_id),
    redirect_uri: first(sp.redirect_uri),
    response_type: first(sp.response_type),
    code_challenge: first(sp.code_challenge),
    code_challenge_method: first(sp.code_challenge_method),
    state: first(sp.state),
    scope: first(sp.scope),
  };

  const v = await validateAuthorizeRequest(params);
  if (!v.ok) return <Message title="Can't connect this app" body={v.error} />;

  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const qs = new URLSearchParams();
      for (const [k, val] of Object.entries(params))
        if (val !== undefined) qs.set(k, val);
      redirect(
        `/login?next=${encodeURIComponent(`/oauth/authorize?${qs.toString()}`)}`
      );
    }
    if (err instanceof ForbiddenError) {
      return <Message title="No account access" body={err.message} />;
    }
    throw err;
  }

  if (!hasMinRole(ctx.role, 'admin')) {
    return (
      <Message
        title="Admin access required"
        body={`Connecting an app gives it access to ${ctx.account.name}. Ask an admin or owner of this account to approve it.`}
      />
    );
  }

  const requested = parseRequestedScopes(params.scope);
  const offered =
    requested && requested.length > 0 ? requested : [...OAUTH_SCOPES];
  const preselected =
    requested && requested.length > 0 ? requested : [...DEFAULT_OAUTH_SCOPES];

  return (
    <Shell>
      <ConsentForm
        clientName={v.client.client_name}
        redirectHost={
          new URL(v.redirectUri).host || new URL(v.redirectUri).protocol
        }
        accountName={ctx.account.name}
        request={{
          client_id: v.client.client_id,
          redirect_uri: v.redirectUri,
          code_challenge: v.codeChallenge,
          state: v.state ?? null,
        }}
        scopes={offered.map((s) => ({
          id: s,
          description: SCOPE_DESCRIPTIONS[s],
          checked: preselected.includes(s),
        }))}
      />
    </Shell>
  );
}
