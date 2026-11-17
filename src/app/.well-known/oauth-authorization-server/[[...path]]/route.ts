// RFC 8414 authorization-server metadata.

import {
  authorizationServerMetadata,
  corsPreflight,
  getOrigin,
  oauthJson,
} from '@/lib/oauth/http';

export async function GET(request: Request) {
  return oauthJson(authorizationServerMetadata(getOrigin(request)), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

export const OPTIONS = corsPreflight;
