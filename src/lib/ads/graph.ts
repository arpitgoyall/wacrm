import { createHmac } from 'node:crypto';

export const ADS_GRAPH_VERSION = process.env.META_ADS_GRAPH_VERSION || 'v26.0';
export type GraphObject = Record<string, unknown>;
export class GraphError extends Error {
  constructor(
    message: string,
    public code: number,
    public transient: boolean
  ) {
    super(message);
  }
}
export async function graph<T = GraphObject>(
  path: string,
  token: string,
  params: GraphObject = {},
  method: 'GET' | 'POST' = 'GET'
): Promise<T> {
  if (!/^[\w/]+$/.test(path)) throw Error('Invalid Meta resource');
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined)
      values.set(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      );
  if (process.env.META_APP_SECRET)
    values.set(
      'appsecret_proof',
      createHmac('sha256', process.env.META_APP_SECRET)
        .update(token)
        .digest('hex')
    );
  const url = `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${path}`;
  const response = await fetch(method === 'GET' ? `${url}?${values}` : url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST'
        ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : {}),
    },
    body: method === 'POST' ? values : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error)
    throw new GraphError(
      body.error?.error_user_msg ||
        body.error?.message ||
        `Meta request failed (${response.status})`,
      Number(body.error?.code || response.status),
      Boolean(
        body.error?.is_transient ||
        response.status === 429 ||
        response.status >= 500
      )
    );
  return body as T;
}
export async function graphPages<T>(
  path: string,
  token: string,
  params: GraphObject = {}
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 500; page++) {
    const result = await graph<{
      data: T[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(path, token, { ...params, limit: 100, after });
    rows.push(...(result.data || []));
    if (!result.paging?.next) return rows;
    const next = result.paging.cursors?.after;
    if (!next || next === after)
      throw Error(
        'Meta returned an invalid pagination cursor; sync will retry'
      );
    after = next;
  }
  throw Error(
    'Meta pagination exceeded the supported batch; narrow the reporting range'
  );
}
