# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

There are two ways to connect:

- **Remote connector** — wacrm serves MCP itself at `/api/mcp`. Use this
  for Claude.ai, ChatGPT, and any hosted client. See below.
- **Local stdio server** — [`mcp-server/`](../mcp-server), published to npm
  as [`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Use this for
  Claude Desktop / Claude Code / Cursor running on your machine.

Both are thin wrappers over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Remote connector (Claude.ai, ChatGPT, any hosted client)

wacrm serves MCP over HTTP at `https://<your-domain>/api/mcp`
(Streamable HTTP, stateless). Nothing to install or run: deploy wacrm
and add that URL as a custom connector.

### Sign in with OAuth (recommended)

1. Apply migration `supabase/migrations/079_oauth.sql` (adds the OAuth
   tables; one-time).
2. In Claude.ai or ChatGPT, add a custom connector with the URL
   `https://crm.example.com/api/mcp`. No key needed.
3. The client discovers wacrm's sign-in flow, registers itself, and
   opens a consent page. Sign in to wacrm (an **admin or owner** must
   approve), tick the permissions to grant, and click **Approve**.

How it behaves:

- **Permissions** are the ones you tick on the consent page. The
  connector exposes exactly the tools those scopes allow: with only read
  scopes it is read-only, and `send_message` / `send_broadcast` appear
  only with `messages:send` / `broadcasts:send`. Webhook management is
  never grantable this way.
- **Tokens** are short-lived (1 hour) and refreshed automatically
  (refresh tokens rotate, 90-day sliding lifetime). Each connected app is
  an API key named `OAuth: <app name>` in **Settings → API keys**;
  revoking it there disconnects the app immediately.
- **Endpoints** (for debugging):
  `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/oauth/authorize`,
  `/api/oauth/register` (RFC 7591), `/api/oauth/token`. PKCE (S256) is
  required; only public clients are supported.

### API key instead of OAuth

For clients that don't do OAuth, create a key in **Settings → API keys**
with only the scopes you want, then:

- **Claude Code / Cursor / API clients (header auth, preferred):**

  ```bash
  claude mcp add --transport http wacrm https://crm.example.com/api/mcp \
    --header "Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
  ```

- **Connector UIs that take only a URL and can't do OAuth:** use
  `https://crm.example.com/api/mcp/wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx`.
  The key is in the URL, so treat that URL like a password, use a
  narrowly scoped key, and revoke it if it leaks.

Either way, the same `/api/v1` rules apply underneath: scopes, the
per-key rate limit, and `send_broadcast` requiring `confirm: true`.

## Local server quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
         },
       },
     },
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status.
- **Writes (opt-in):** send a message, create/update a contact.
- **Broadcasts (opt-in):** launch a template broadcast — requires an
  explicit `confirm` and is marked destructive.

## Safety

Because sending WhatsApp messages is a real side effect, the local
server is **read-only until you opt in**, layered on top of the API
key's own scopes; the remote connector is limited by the key's scopes
alone. Give an assistant a read-only key and it physically cannot send
anything. See the [server README](../mcp-server/README.md) for the full
tool list and safety model.
