import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMcpHandler } from './handler';
import { McpApiError, type ApiDispatcher } from './dispatch';

const me = vi.fn();
const listContacts = vi.fn();
const sendBroadcast = vi.fn();

const handler = createMcpHandler(
  () => ({ me, listContacts, sendBroadcast }) as unknown as ApiDispatcher
);
const POST = handler;
const GET = handler;

const KEY = 'wacrm_live_test';

function rpc(
  method: string,
  params: unknown,
  opts: { auth?: string | null; id?: number } = {}
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${KEY}`;
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
  });
}

const ctx = (key?: string[]) => ({ params: Promise.resolve({ key }) });

function withScopes(scopes: string[]) {
  me.mockResolvedValue({
    data: { account: { id: 'a', name: 'A' }, key: { id: 'k', scopes } },
  });
}

async function toolNames(scopes: string[]) {
  withScopes(scopes);
  const res = await POST(rpc('tools/list', {}), ctx());
  const body = await res.json();
  return (body.result.tools as { name: string }[]).map((t) => t.name).sort();
}

describe('/api/mcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests with no key', async () => {
    const res = await POST(rpc('tools/list', {}, { auth: null }), ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects an invalid key', async () => {
    me.mockRejectedValue(new McpApiError(401, 'unauthorized', 'bad'));
    const res = await POST(rpc('tools/list', {}), ctx());
    expect(res.status).toBe(401);
  });

  it('accepts the key from the URL path', async () => {
    withScopes([]);
    const res = await POST(rpc('tools/list', {}, { auth: null }), ctx([KEY]));
    expect(res.status).toBe(200);
  });

  it('completes the initialize handshake', async () => {
    withScopes([]);
    const res = await POST(
      rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('wacrm');
  });

  it('exposes only whoami for a scopeless key', async () => {
    expect(await toolNames([])).toEqual(['whoami']);
  });

  it('exposes read tools but no write tools for a read-only key', async () => {
    const names = await toolNames([
      'contacts:read',
      'conversations:read',
      'messages:read',
    ]);
    expect(names).toEqual([
      'get_contact',
      'get_conversation',
      'list_contacts',
      'list_conversations',
      'list_messages',
      'whoami',
    ]);
  });

  it('exposes write tools only with the matching scopes', async () => {
    const names = await toolNames([
      'contacts:write',
      'messages:send',
      'broadcasts:send',
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_contact',
        'update_contact',
        'send_message',
        'send_broadcast',
      ])
    );
    expect(names).not.toContain('list_contacts');
  });

  it('calls through to the API for a tool call', async () => {
    withScopes(['contacts:read']);
    listContacts.mockResolvedValue({ data: [{ id: 'c1' }], next_cursor: null });
    const res = await POST(
      rpc('tools/call', {
        name: 'list_contacts',
        arguments: { search: 'jane' },
      }),
      ctx()
    );
    const body = await res.json();
    expect(listContacts).toHaveBeenCalledWith({ search: 'jane' });
    expect(body.result.content[0].text).toContain('c1');
  });

  it('surfaces API errors as tool errors, not protocol errors', async () => {
    withScopes(['contacts:read']);
    listContacts.mockRejectedValue(
      new McpApiError(429, 'rate_limited', 'slow down')
    );
    const res = await POST(
      rpc('tools/call', { name: 'list_contacts', arguments: {} }),
      ctx()
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('rate_limited');
  });

  it('refuses to broadcast without confirm=true', async () => {
    withScopes(['broadcasts:send']);
    const res = await POST(
      rpc('tools/call', {
        name: 'send_broadcast',
        arguments: {
          name: 'x',
          template_name: 't',
          template_language: 'en_US',
          recipients: [{ to: '+14155550123' }],
          confirm: false,
        },
      }),
      ctx()
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('does not support the SSE GET stream (stateless)', async () => {
    withScopes([]);
    const res = await GET(
      new Request('http://localhost/api/mcp', {
        headers: {
          authorization: `Bearer ${KEY}`,
          accept: 'text/event-stream',
        },
      }),
      ctx()
    );
    expect(res.status).toBe(405);
  });
});
