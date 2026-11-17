// ============================================================
// POST /api/oauth/token — authorization_code and refresh_token grants.
//
// Public clients only (PKCE S256 required). Errors follow RFC 6749 §5.2.
// ============================================================

import { checkRateLimit } from '@/lib/rate-limit';
import { verifyPkceS256 } from '@/lib/oauth/core';
import {
  consumeAuthCode,
  getClient,
  issueTokens,
  rotateRefreshToken,
  type IssuedTokens,
} from '@/lib/oauth/store';
import {
  clientIp,
  corsPreflight,
  oauthError,
  oauthJson,
} from '@/lib/oauth/http';

function tokenResponse(t: IssuedTokens) {
  return oauthJson({
    access_token: t.access_token,
    token_type: 'Bearer',
    expires_in: t.expires_in,
    refresh_token: t.refresh_token,
    scope: t.scopes.join(' '),
  });
}

export async function POST(request: Request) {
  const limit = checkRateLimit(`oauth:token:${clientIp(request)}`, {
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.success) {
    return oauthError('temporarily_unavailable', 'Too many requests', 429);
  }

  const form = await request.formData().catch(() => null);
  if (!form)
    return oauthError(
      'invalid_request',
      'Expected application/x-www-form-urlencoded'
    );
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };

  const clientId = get('client_id');
  const client = clientId ? await getClient(clientId) : null;
  if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);

  try {
    const grant = get('grant_type');

    if (grant === 'authorization_code') {
      const code = get('code');
      const verifier = get('code_verifier');
      const redirectUri = get('redirect_uri');
      if (!code || !verifier) {
        return oauthError(
          'invalid_request',
          'code and code_verifier are required'
        );
      }

      const row = await consumeAuthCode(code);
      if (!row || row.client_id !== client.client_id) {
        return oauthError(
          'invalid_grant',
          'Authorization code is invalid, used, or expired'
        );
      }
      if (row.redirect_uri !== redirectUri) {
        return oauthError(
          'invalid_grant',
          'redirect_uri does not match the authorization request'
        );
      }
      if (!verifyPkceS256(verifier, row.code_challenge)) {
        return oauthError('invalid_grant', 'PKCE verification failed');
      }

      return tokenResponse(
        await issueTokens({
          client,
          accountId: row.account_id,
          userId: row.user_id,
          scopes: row.scopes,
        })
      );
    }

    if (grant === 'refresh_token') {
      const refresh = get('refresh_token');
      if (!refresh)
        return oauthError('invalid_request', 'refresh_token is required');
      const tokens = await rotateRefreshToken(refresh, client.client_id);
      if (!tokens)
        return oauthError(
          'invalid_grant',
          'Refresh token is invalid or expired'
        );
      return tokenResponse(tokens);
    }

    return oauthError(
      'unsupported_grant_type',
      'Use authorization_code or refresh_token'
    );
  } catch (err) {
    console.error('[oauth/token]', err);
    return oauthError('server_error', 'Token request failed', 500);
  }
}

export const OPTIONS = corsPreflight;
