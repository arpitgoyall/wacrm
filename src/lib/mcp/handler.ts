// ============================================================
// Request handler for the remote MCP endpoint (see
// src/app/api/mcp/[[...key]]/route.ts for the auth / transport
// overview). Lives here, taking the API dispatcher as a dependency,
// so it can be tested without the Supabase-backed /api/v1 stack.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpApiError, type ApiDispatcher } from './dispatch';
import { registerTools } from './tools';
import { getOrigin, protectedResourceMetadataUrl } from '@/lib/oauth/http';

export type ApiFactory = (apiKey: string) => ApiDispatcher;

const SERVER_INFO = { name: 'wacrm', version: '1.0.0' };

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  extra?: HeadersInit
) {
  return withCors(
    new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
      {
        status,
        headers: { 'Content-Type': 'application/json', ...extra },
      }
    )
  );
}

function extractKey(
  request: Request,
  pathKey: string | undefined
): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const value = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : header.trim();
    if (value) return value;
  }
  return pathKey && pathKey.length > 0 ? pathKey : null;
}

export function createMcpHandler(createApi: ApiFactory) {
  return async function handleMcp(
    request: Request,
    { params }: { params: Promise<{ key?: string[] }> }
  ): Promise<Response> {
    // Stateless server: no SSE stream to open and no session to delete.
    // The spec lets servers refuse these with 405.
    if (request.method !== 'POST') {
      return withCors(
        new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS' } })
      );
    }

    const { key: segments } = await params;
    if (segments && segments.length > 1) {
      return jsonRpcError(404, -32601, 'Not found');
    }

    // Points OAuth-capable clients (Claude.ai, ChatGPT) at the sign-in
    // flow (RFC 9728); header/URL-key clients simply ignore it.
    const resourceMetadata = protectedResourceMetadataUrl(getOrigin(request));

    const apiKey = extractKey(request, segments?.[0]);
    if (!apiKey) {
      return jsonRpcError(
        401,
        -32001,
        'Missing credentials. Sign in via OAuth or send "Authorization: Bearer <key>".',
        {
          'WWW-Authenticate': `Bearer realm="wacrm", resource_metadata="${resourceMetadata}"`,
        }
      );
    }

    // Authenticate once up front and learn the key's scopes — they decide
    // which tools this connection gets to see.
    const api = createApi(apiKey);
    let scopes: string[];
    try {
      scopes = (await api.me()).data.key.scopes;
    } catch (err) {
      if (err instanceof McpApiError) {
        if (err.status === 401) {
          return jsonRpcError(
            401,
            -32001,
            'Invalid, revoked, or expired API key.',
            {
              'WWW-Authenticate': `Bearer realm="wacrm", error="invalid_token", resource_metadata="${resourceMetadata}"`,
            }
          );
        }
        if (err.status === 429) {
          return jsonRpcError(429, -32002, err.message);
        }
      }
      console.error('[mcp] auth error:', err);
      return jsonRpcError(500, -32603, 'Internal error');
    }

    const server = new McpServer(SERVER_INFO, {
      instructions:
        'wacrm is a WhatsApp CRM. Tools are limited to what this API key is scoped for. ' +
        'Sending messages and broadcasts reaches real people — confirm recipients and content with the user first.',
    });
    registerTools(server, api, scopes);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      return withCors(await transport.handleRequest(request));
    } catch (err) {
      console.error('[mcp] transport error:', err);
      return jsonRpcError(500, -32603, 'Internal error');
    }
  };
}
