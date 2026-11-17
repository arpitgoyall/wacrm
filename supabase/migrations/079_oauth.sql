-- ============================================================
-- 079_oauth.sql — OAuth 2.1 for the remote MCP connector
--
-- Lets MCP clients (Claude.ai, ChatGPT, …) sign in through a consent
-- screen instead of pasting an API key. The design reuses `api_keys`:
-- an OAuth access token IS an API key (1-hour expiry, scopes picked on
-- the consent screen), so scope checks, rate limits and revocation all
-- keep working unchanged, and each connected app shows up in
-- Settings → API keys. These tables hold only what OAuth adds on top:
--
--   oauth_clients         — dynamically registered clients (RFC 7591)
--   oauth_auth_codes      — short-lived, single-use authorization codes
--   oauth_refresh_tokens  — one rotating refresh token per api_keys row
--
-- Codes and refresh tokens are stored as SHA-256 hashes (they are
-- full-entropy random strings; see src/lib/api-keys/keys.ts).
--
-- RLS is enabled with NO policies: these tables are touched only by the
-- OAuth route handlers through the service-role client. The anon and
-- authenticated roles can read or write nothing.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     text PRIMARY KEY,
  client_name   text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  code_challenge text NOT NULL,           -- PKCE S256 challenge
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx
  ON oauth_auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  api_key_id  uuid PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  client_id   text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE oauth_clients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_auth_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
