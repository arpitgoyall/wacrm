// ============================================================
// Authorization-request validation, shared by the consent page
// (server component) and the approve/deny endpoint so both apply the
// same rules. Errors in client_id / redirect_uri are NEVER redirected
// back to the client (RFC 6749 §4.1.2.1) — they are shown to the user.
// ============================================================

import { isValidCodeChallenge, redirectUriMatches } from './core';
import { getClient, type OAuthClient } from './store';

export interface AuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
}

export type AuthorizeValidation =
  | {
      ok: true;
      client: OAuthClient;
      redirectUri: string;
      codeChallenge: string;
      state: string | undefined;
    }
  | { ok: false; error: string };

export async function validateAuthorizeRequest(
  p: AuthorizeParams
): Promise<AuthorizeValidation> {
  if (!p.client_id) return { ok: false, error: 'Missing client_id.' };
  const client = await getClient(p.client_id);
  if (!client) return { ok: false, error: 'Unknown application.' };

  if (
    !p.redirect_uri ||
    !redirectUriMatches(client.redirect_uris, p.redirect_uri)
  ) {
    return {
      ok: false,
      error:
        'The redirect address does not match what this application registered.',
    };
  }
  if (p.response_type !== 'code') {
    return { ok: false, error: 'Unsupported response_type (expected "code").' };
  }
  if (
    p.code_challenge_method !== 'S256' ||
    !isValidCodeChallenge(p.code_challenge)
  ) {
    return {
      ok: false,
      error: 'PKCE with code_challenge_method=S256 is required.',
    };
  }

  return {
    ok: true,
    client,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge!,
    state: p.state,
  };
}

/** Build the URL the browser is sent back to the client with. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}
