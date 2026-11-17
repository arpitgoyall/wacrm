import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  clampScopes,
  isValidCodeChallenge,
  isValidRedirectUri,
  parseRequestedScopes,
  redirectUriMatches,
  safeNextPath,
  verifyPkceS256,
} from './core';
import { buildRedirect } from './authorize';
import { getOrigin, protectedResourceMetadataUrl } from './http';

const verifier = 'a'.repeat(43) + 'B-._~9';
const challenge = createHash('sha256').update(verifier).digest('base64url');

describe('PKCE', () => {
  it('accepts the matching verifier', () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });
  it('rejects a wrong or malformed verifier', () => {
    expect(verifyPkceS256('b'.repeat(50), challenge)).toBe(false);
    expect(verifyPkceS256('short', challenge)).toBe(false);
    expect(isValidCodeChallenge('plain-text-challenge')).toBe(false);
  });
});

describe('redirect URIs', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:8080/cb',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
  ])('allows %s', (u) => expect(isValidRedirectUri(u)).toBe(true));

  it.each([
    'http://evil.example.com/cb',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://a.com/cb#frag',
    'https://user:pw@a.com/cb',
    'not a url',
    '',
  ])('rejects %s', (u) => expect(isValidRedirectUri(u)).toBe(false));

  it('matches exactly, never by prefix', () => {
    const reg = ['https://a.com/cb'];
    expect(redirectUriMatches(reg, 'https://a.com/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'https://a.com/cb/evil')).toBe(false);
    expect(redirectUriMatches(reg, 'https://a.com/cb?x=1')).toBe(false);
  });
});

describe('scopes', () => {
  it('parses known scopes and drops unknown / webhook ones', () => {
    expect(parseRequestedScopes('contacts:read bogus webhooks:manage')).toEqual(
      ['contacts:read']
    );
    expect(parseRequestedScopes('')).toBeNull();
  });
  it('clamps user-chosen scopes', () => {
    expect(clampScopes(['contacts:read', 'webhooks:manage', 'x'])).toEqual([
      'contacts:read',
    ]);
    expect(clampScopes('nope')).toEqual([]);
  });
});

describe('safeNextPath', () => {
  it('allows relative paths only', () => {
    expect(safeNextPath('/oauth/authorize?a=1')).toBe('/oauth/authorize?a=1');
    expect(safeNextPath('//evil.com')).toBeNull();
    expect(safeNextPath('https://evil.com')).toBeNull();
    expect(safeNextPath('/' + String.fromCharCode(92) + 'evil.com')).toBeNull();
  });
});

describe('helpers', () => {
  it('builds redirects, preserving existing query and omitting undefined', () => {
    expect(
      buildRedirect('https://a.com/cb?x=1', { code: 'c', state: undefined })
    ).toBe('https://a.com/cb?x=1&code=c');
  });
  it('derives origin from forwarded headers', () => {
    const r = new Request('http://internal:3000/x', {
      headers: {
        'x-forwarded-host': 'crm.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(getOrigin(r)).toBe('https://crm.example.com');
    expect(protectedResourceMetadataUrl('https://crm.example.com')).toBe(
      'https://crm.example.com/.well-known/oauth-protected-resource/api/mcp'
    );
  });
});
