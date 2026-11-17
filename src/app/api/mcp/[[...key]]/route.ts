// ============================================================
// /api/mcp — remote Model Context Protocol server (Streamable HTTP).
//
// Lets hosted AI clients (Claude, ChatGPT, Cursor, …) connect to wacrm
// as a custom connector without running anything locally. It's the
// remote twin of the stdio package in /mcp-server and shares the same
// safety model: the connector can only do what the API key's scopes
// allow, because every tool call goes through the real /api/v1
// handlers (see src/lib/mcp/dispatch.ts).
//
// Authentication — an API key from Settings → API keys, presented as:
//   1. `Authorization: Bearer wacrm_live_…`   (preferred; Claude Code,
//      Cursor, the Anthropic/OpenAI APIs, MCP Inspector, …)
//   2. a URL path segment: `/api/mcp/wacrm_live_…`  — for connector UIs
//      that only accept a URL and offer no header field (Claude.ai and
//      ChatGPT custom connectors). The key IS the credential in that
//      case, so treat the URL like a password.
//
// Stateless: a fresh server + transport per request, JSON responses
// (no SSE session to keep alive), so it works on serverless hosts.
// ============================================================

import { ApiDispatcher } from '@/lib/mcp/dispatch';
import { createMcpHandler, CORS_HEADERS } from '@/lib/mcp/handler';

const handleMcp = createMcpHandler((key) => new ApiDispatcher(key));

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
