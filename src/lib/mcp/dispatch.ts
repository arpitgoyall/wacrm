// ============================================================
// In-process dispatcher to the public API (/api/v1).
//
// The remote MCP endpoint is a thin adapter over the public API: every
// tool call is turned into a synthetic `Request` carrying the caller's
// API key and handed straight to the matching `/api/v1` route handler.
// That keeps ONE implementation of auth, scope checks, rate limiting
// and the response envelope — the MCP layer can't drift from, or
// bypass, the REST rules. No network hop is involved.
// ============================================================

import * as me from '@/app/api/v1/me/route';
import * as contacts from '@/app/api/v1/contacts/route';
import * as contactById from '@/app/api/v1/contacts/[id]/route';
import * as conversations from '@/app/api/v1/conversations/route';
import * as conversationById from '@/app/api/v1/conversations/[id]/route';
import * as conversationMessages from '@/app/api/v1/conversations/[id]/messages/route';
import * as messages from '@/app/api/v1/messages/route';
import * as broadcasts from '@/app/api/v1/broadcasts/route';
import * as broadcastById from '@/app/api/v1/broadcasts/[id]/route';

/** A structured error from the API envelope (`{ error: { code, message } }`). */
export class McpApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'McpApiError';
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | undefined>;
type Handler = (
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response> | Response;
type Handlers = Partial<Record<'GET' | 'POST' | 'PATCH', Handler>>;

interface Route {
  handlers: Handlers;
  id?: string;
}

// Synthetic origin — never leaves the process; only the path matters.
const ORIGIN = 'http://wacrm.internal';

export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

export class ApiDispatcher {
  constructor(private readonly apiKey: string) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    route: Route,
    opts: { query?: Query; body?: unknown } = {}
  ): Promise<{ data: T; meta?: { next_cursor: string | null } }> {
    const url = new URL(`${ORIGIN}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const request = new Request(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const handler = route.handlers[method];
    if (!handler)
      throw new McpApiError(405, 'internal', 'Method not supported');

    const res = await handler(request, {
      params: Promise.resolve({ id: route.id ?? '' }),
    });

    const text = await res.text();
    let payload: unknown;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (!res.ok)
          throw new McpApiError(res.status, 'internal', text.slice(0, 500));
      }
    }

    if (!res.ok) {
      const env = payload as
        { error?: { code?: string; message?: string } } | undefined;
      let message =
        env?.error?.message ?? `Request failed with status ${res.status}`;
      if (res.status === 429) {
        const retry = res.headers.get('Retry-After');
        if (retry) message += ` (retry after ${retry}s)`;
      }
      throw new McpApiError(
        res.status,
        env?.error?.code ?? 'internal',
        message
      );
    }

    return payload as { data: T; meta?: { next_cursor: string | null } };
  }

  private async list<T>(
    path: string,
    route: Route,
    query: Query
  ): Promise<Paginated<T>> {
    const res = await this.call<T[]>('GET', path, route, { query });
    return { data: res.data, next_cursor: res.meta?.next_cursor ?? null };
  }

  // --- Identity -----------------------------------------------------

  me() {
    return this.call<{
      account: { id: string; name: string | null };
      key: { id: string; scopes: string[] };
    }>('GET', '/me', { handlers: me });
  }

  // --- Contacts -----------------------------------------------------

  listContacts(query: Query) {
    return this.list('/contacts', { handlers: contacts }, query);
  }
  getContact(id: string) {
    return this.call('GET', `/contacts/${encodeURIComponent(id)}`, {
      handlers: contactById,
      id,
    });
  }
  createContact(body: unknown) {
    return this.call('POST', '/contacts', { handlers: contacts }, { body });
  }
  updateContact(id: string, body: unknown) {
    return this.call(
      'PATCH',
      `/contacts/${encodeURIComponent(id)}`,
      { handlers: contactById, id },
      { body }
    );
  }

  // --- Conversations / messages ------------------------------------

  listConversations(query: Query) {
    return this.list('/conversations', { handlers: conversations }, query);
  }
  getConversation(id: string) {
    return this.call('GET', `/conversations/${encodeURIComponent(id)}`, {
      handlers: conversationById,
      id,
    });
  }
  listConversationMessages(id: string, query: Query) {
    return this.list(
      `/conversations/${encodeURIComponent(id)}/messages`,
      { handlers: conversationMessages, id },
      query
    );
  }
  sendMessage(body: unknown) {
    return this.call('POST', '/messages', { handlers: messages }, { body });
  }

  // --- Broadcasts ---------------------------------------------------

  sendBroadcast(body: unknown) {
    return this.call('POST', '/broadcasts', { handlers: broadcasts }, { body });
  }
  getBroadcast(id: string) {
    return this.call('GET', `/broadcasts/${encodeURIComponent(id)}`, {
      handlers: broadcastById,
      id,
    });
  }
}
