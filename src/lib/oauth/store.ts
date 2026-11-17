// ============================================================
// OAuth data access — service-role only (these tables have RLS on
// and no policies, see migration 079).
//
// Access tokens are `api_keys` rows: minting a token inserts a key,
// refreshing rotates that key's hash + expiry in place. That keeps a
// single revocation surface (Settings → API keys) and means the whole
// public-API auth path works for OAuth callers with no changes.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { API_KEY_PREFIX, hashApiKey } from '@/lib/api-keys/keys';
import { randomBytes } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
  newClientId,
  randomToken,
  sha256Hex,
} from './core';

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export async function registerClient(
  name: string,
  redirectUris: string[]
): Promise<OAuthClient> {
  const row = {
    client_id: newClientId(),
    client_name: name,
    redirect_uris: redirectUris,
  };
  const { error } = await supabaseAdmin().from('oauth_clients').insert(row);
  if (error) throw new Error(`registerClient: ${error.message}`);
  return row;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const { data, error } = await supabaseAdmin()
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error || !data) return null;
  return data as OAuthClient;
}

/** Create a single-use authorization code; returns the plaintext. */
export async function createAuthCode(input: {
  clientId: string;
  accountId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken('wacrm_code_');
  const { error } = await supabaseAdmin()
    .from('oauth_auth_codes')
    .insert({
      code_hash: sha256Hex(code),
      client_id: input.clientId,
      account_id: input.accountId,
      user_id: input.userId,
      redirect_uri: input.redirectUri,
      scopes: input.scopes,
      code_challenge: input.codeChallenge,
      expires_at: new Date(
        Date.now() + AUTH_CODE_TTL_SECONDS * 1000
      ).toISOString(),
    });
  if (error) throw new Error(`createAuthCode: ${error.message}`);
  return code;
}

export interface AuthCodeRow {
  client_id: string;
  account_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
}

/**
 * Atomically consume a code: the UPDATE … WHERE used_at IS NULL means
 * two concurrent exchanges of the same code can't both win. Returns
 * null if the code is unknown, already used, or expired.
 */
export async function consumeAuthCode(
  code: string
): Promise<AuthCodeRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('oauth_auth_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code_hash', sha256Hex(code))
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select(
      'client_id, account_id, user_id, redirect_uri, scopes, code_challenge'
    )
    .maybeSingle();
  if (error || !data) return null;
  return data as AuthCodeRow;
}

function newApiKey() {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, API_KEY_PREFIX.length + 8),
  };
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scopes: string[];
}

function refreshExpiry(): string {
  return new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000
  ).toISOString();
}

/** Mint the api_keys row + refresh token for a freshly exchanged code. */
export async function issueTokens(input: {
  client: OAuthClient;
  accountId: string;
  userId: string;
  scopes: string[];
}): Promise<IssuedTokens> {
  const db = supabaseAdmin();
  const key = newApiKey();
  const refresh = randomToken('wacrm_refresh_');

  const { data, error } = await db
    .from('api_keys')
    .insert({
      account_id: input.accountId,
      created_by: input.userId,
      name: `OAuth: ${input.client.client_name}`.slice(0, 80),
      key_prefix: key.prefix,
      key_hash: key.hash,
      scopes: input.scopes,
      expires_at: new Date(
        Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000
      ).toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`issueTokens(key): ${error?.message}`);

  const { error: rErr } = await db.from('oauth_refresh_tokens').insert({
    api_key_id: data.id,
    client_id: input.client.client_id,
    token_hash: sha256Hex(refresh),
    expires_at: refreshExpiry(),
  });
  if (rErr) {
    // Don't leave a usable access token without its refresh row.
    await db.from('api_keys').delete().eq('id', data.id);
    throw new Error(`issueTokens(refresh): ${rErr.message}`);
  }

  return {
    access_token: key.plaintext,
    refresh_token: refresh,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scopes: input.scopes,
  };
}

/**
 * Rotate a refresh token: validates it (right client, unexpired, key
 * not revoked), then swaps in a new access key hash + refresh hash on
 * the same rows. Returns null for any invalid state. The old refresh
 * token stops working the moment the new hash is written.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string
): Promise<IssuedTokens | null> {
  const db = supabaseAdmin();
  const oldHash = sha256Hex(refreshToken);

  const { data: row } = await db
    .from('oauth_refresh_tokens')
    .select('api_key_id, client_id, expires_at')
    .eq('token_hash', oldHash)
    .maybeSingle();
  if (!row || row.client_id !== clientId) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  const { data: keyRow } = await db
    .from('api_keys')
    .select('scopes, revoked_at')
    .eq('id', row.api_key_id)
    .maybeSingle();
  if (!keyRow || keyRow.revoked_at) return null;

  const newRefresh = randomToken('wacrm_refresh_');
  // Compare-and-swap on the old hash so a replayed token can't rotate twice.
  const { data: swapped } = await db
    .from('oauth_refresh_tokens')
    .update({ token_hash: sha256Hex(newRefresh), expires_at: refreshExpiry() })
    .eq('api_key_id', row.api_key_id)
    .eq('token_hash', oldHash)
    .select('api_key_id')
    .maybeSingle();
  if (!swapped) return null;

  const key = newApiKey();
  const { error } = await db
    .from('api_keys')
    .update({
      key_hash: key.hash,
      key_prefix: key.prefix,
      expires_at: new Date(
        Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000
      ).toISOString(),
    })
    .eq('id', row.api_key_id)
    .is('revoked_at', null);
  if (error) {
    console.error('[oauth] refresh key rotation failed:', error.message);
    return null;
  }

  return {
    access_token: key.plaintext,
    refresh_token: newRefresh,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scopes: keyRow.scopes as string[],
  };
}
