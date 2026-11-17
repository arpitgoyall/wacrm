// ============================================================
// POST /api/oauth/register — RFC 7591 dynamic client registration.
//
// MCP clients register themselves on first connect. Only public
// clients (PKCE, no client secret) are supported. Registration grants
// nothing by itself: a client still needs a signed-in admin to approve
// it on the consent screen.
// ============================================================

import { checkRateLimit } from '@/lib/rate-limit';
import { isValidRedirectUri } from '@/lib/oauth/core';
import { registerClient } from '@/lib/oauth/store';
import {
  clientIp,
  corsPreflight,
  oauthError,
  oauthJson,
} from '@/lib/oauth/http';

const MAX_REDIRECT_URIS = 10;

export async function POST(request: Request) {
  const limit = checkRateLimit(`oauth:register:${clientIp(request)}`, {
    limit: 20,
    windowMs: 60 * 60_000,
  });
  if (!limit.success) {
    return oauthError(
      'temporarily_unavailable',
      'Too many registrations, try later',
      429
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object') {
    return oauthError('invalid_client_metadata', 'Body must be a JSON object');
  }

  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every(isValidRedirectUri)
  ) {
    return oauthError(
      'invalid_redirect_uri',
      'redirect_uris must be 1-10 valid https, loopback http, or app-scheme URIs'
    );
  }

  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    return oauthError(
      'invalid_client_metadata',
      'Only token_endpoint_auth_method "none" (PKCE public clients) is supported'
    );
  }

  const rawName =
    typeof body.client_name === 'string' ? body.client_name.trim() : '';
  // Strip control characters; the name is shown on the consent screen.
  const name = (rawName.replace(/[\x00-\x1f\x7f]/g, '') || 'MCP client').slice(
    0,
    60
  );

  try {
    const client = await registerClient(name, uris as string[]);
    return oauthJson(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201
    );
  } catch (err) {
    console.error('[oauth/register]', err);
    return oauthError('server_error', 'Could not register client', 500);
  }
}

export const OPTIONS = corsPreflight;
