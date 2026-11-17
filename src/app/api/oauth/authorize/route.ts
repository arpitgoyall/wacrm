// ============================================================
// POST /api/oauth/authorize — the consent screen's approve / deny.
//
// Authenticated by the dashboard cookie session (NOT a bearer key) and
// restricted to admin+, the same bar as minting an API key by hand: an
// OAuth grant is a key with a friendlier front door. Returns the URL
// the browser should navigate to (the client's redirect_uri carrying
// either `code` or `error`).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { buildRedirect, validateAuthorizeRequest } from '@/lib/oauth/authorize';
import { clampScopes } from '@/lib/oauth/core';
import { createAuthCode } from '@/lib/oauth/store';

export async function POST(request: Request) {
  try {
    // Cookie-authenticated state change: require a JSON content type so
    // a cross-site <form> post can't trigger it (JSON needs a CORS
    // preflight that this route never grants).
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json(
        { error: 'Expected application/json' },
        { status: 415 }
      );
    }

    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:oauthAuthorize:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

    const str = (k: string) =>
      typeof body[k] === 'string' ? (body[k] as string) : undefined;
    const v = await validateAuthorizeRequest({
      client_id: str('client_id'),
      redirect_uri: str('redirect_uri'),
      response_type: 'code',
      code_challenge: str('code_challenge'),
      code_challenge_method: 'S256',
      state: str('state'),
    });
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

    if (body.decision !== 'approve') {
      return NextResponse.json({
        redirect: buildRedirect(v.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied the request',
          state: v.state,
        }),
      });
    }

    const scopes = clampScopes(body.scopes);
    if (scopes.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one permission' },
        { status: 400 }
      );
    }

    const code = await createAuthCode({
      clientId: v.client.client_id,
      accountId: ctx.accountId,
      userId: ctx.userId,
      redirectUri: v.redirectUri,
      scopes,
      codeChallenge: v.codeChallenge,
    });

    return NextResponse.json({
      redirect: buildRedirect(v.redirectUri, { code, state: v.state }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
