// RFC 9728 protected-resource metadata. Served at both
// /.well-known/oauth-protected-resource and the path-suffixed
// .../api/mcp form that MCP clients probe.

import {
  corsPreflight,
  getOrigin,
  oauthJson,
  protectedResourceMetadata,
} from '@/lib/oauth/http';

export async function GET(request: Request) {
  return oauthJson(protectedResourceMetadata(getOrigin(request)), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

export const OPTIONS = corsPreflight;
