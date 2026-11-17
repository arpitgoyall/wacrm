// ============================================================
// OAuth core — pure helpers (no I/O), unit-tested.
//
// PKCE verification, redirect-URI validation, scope parsing, and
// token/ID generation for the MCP connector's OAuth 2.1 flow.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_SCOPES, type ApiScope } from '@/lib/api-keys/scopes';

/** Scopes an OAuth client may be granted. Webhook management is
 *  excluded: no MCP tool needs it and it's too powerful to hand out
 *  through a consent screen. */
export const OAUTH_SCOPES: readonly ApiScope[] = API_SCOPES.filter(
  (s) => s !== 'webhooks:manage'
);

/** Scopes pre-selected on the consent screen when the client
 *  doesn't ask for specific ones. Read-only by default. */
export const DEFAULT_OAUTH_SCOPES: readonly ApiScope[] = [
  'contacts:read',
  'conversations:read',
  'messages:read',
];

export const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour
export const REFRESH_TOKEN_TTL_DAYS = 90;
export const AUTH_CODE_TTL_SECONDS = 600; // 10 minutes

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Opaque, URL-safe random token with a recognisable prefix. */
export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function newClientId(): string {
  return `wacrm_client_${randomBytes(16).toString('base64url')}`;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: verifier is 43–128 unreserved characters.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A valid S256 challenge is a base64url SHA-256 digest (43 chars). */
export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-_]{43}$/.test(value);
}

/**
 * Validate a redirect URI at client registration. Allowed:
 *   - https://…                       (hosted clients: Claude.ai, ChatGPT)
 *   - http://localhost / 127.0.0.1 / [::1]  (local tools, any port)
 *   - custom app schemes (e.g. `cursor://…`) for native apps
 * Rejected: javascript:/data:/file:/etc., fragments, userinfo, and
 * plain http to a non-loopback host (tokens would cross the wire).
 */
export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;

  const scheme = url.protocol;
  if (scheme === 'https:') return true;
  if (scheme === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }
  const blocked = [
    'javascript:',
    'data:',
    'file:',
    'vbscript:',
    'blob:',
    'about:',
    'ftp:',
    'ws:',
    'wss:',
  ];
  return !blocked.includes(scheme);
}

/** Exact string match, per OAuth 2.1 — no prefix or wildcard matching.
 *  (Loopback ports may legitimately vary per RFC 8252 §7.3; clients
 *  that need that register with the port they will use.) */
export function redirectUriMatches(
  registered: readonly string[],
  presented: string
) {
  return registered.includes(presented);
}

/** Parse a space-delimited `scope` string into known OAuth scopes.
 *  Unknown tokens are dropped. Returns null when none was requested. */
export function parseRequestedScopes(
  raw: string | null | undefined
): ApiScope[] | null {
  if (!raw || !raw.trim()) return null;
  const out: ApiScope[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const scope = OAUTH_SCOPES.find((s) => s === token);
    if (scope && !out.includes(scope)) out.push(scope);
  }
  return out;
}

/** Restrict user-chosen scopes to those the client may be granted. */
export function clampScopes(chosen: unknown): ApiScope[] {
  if (!Array.isArray(chosen)) return [];
  return OAUTH_SCOPES.filter((s) => chosen.includes(s));
}

/** Only same-site relative paths are allowed as post-login targets. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\'))
    return null;
  return raw;
}
