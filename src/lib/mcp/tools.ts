// ============================================================
// MCP tool definitions for the remote endpoint.
//
// Unlike the local stdio server (which uses env flags to opt into
// writes), the remote server derives what to expose from the API
// key itself: a tool is only registered when the key carries the
// scope it needs. A read-only key therefore yields a read-only
// connector — the model never even sees `send_message`.
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiScope } from '@/lib/api-keys/scopes';
import { McpApiError, type ApiDispatcher } from './dispatch';

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Turn API failures into model-readable error results instead of protocol errors. */
function handle<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      if (err instanceof McpApiError) {
        return errorResult(`wacrm API error [${err.code}]: ${err.message}`);
      }
      console.error('[mcp] tool error:', err);
      return errorResult('Unexpected error while calling the wacrm API.');
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

const limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Page size, 1–100 (default 50).');
const cursor = z
  .string()
  .optional()
  .describe('Opaque pagination cursor from a previous response.');

export function registerTools(
  server: McpServer,
  api: ApiDispatcher,
  scopes: readonly string[]
): string[] {
  const can = (s: ApiScope) => scopes.includes(s);
  const registered: string[] = [];
  const note = (name: string) => registered.push(name);

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Show which wacrm account this connector is bound to and what scopes its API key carries.',
      inputSchema: {},
      annotations: { ...READ, title: 'Who am I' },
    },
    handle(async () => api.me())
  );
  note('whoami');

  if (can('contacts:read')) {
    server.registerTool(
      'list_contacts',
      {
        title: 'List contacts',
        description:
          'List contacts, newest first. Optionally filter by free-text search (name or phone) or a tag id. Paginated: pass next_cursor to get the next page.',
        inputSchema: {
          search: z
            .string()
            .optional()
            .describe('Free-text search over name or phone number.'),
          tag: z.string().optional().describe('Tag id to filter by.'),
          limit,
          cursor,
        },
        annotations: { ...READ, title: 'List contacts' },
      },
      handle(async (args) => api.listContacts(args))
    );
    note('list_contacts');

    server.registerTool(
      'get_contact',
      {
        title: 'Get contact',
        description: 'Read a single contact by id.',
        inputSchema: { id: z.string().describe('Contact id.') },
        annotations: { ...READ, title: 'Get contact' },
      },
      handle(async ({ id }) => api.getContact(id))
    );
    note('get_contact');
  }

  if (can('conversations:read')) {
    server.registerTool(
      'list_conversations',
      {
        title: 'List conversations',
        description:
          'List conversations, newest first. Optionally filter by status (open / pending / closed) or contact id. Paginated.',
        inputSchema: {
          status: z.enum(['open', 'pending', 'closed']).optional(),
          contact_id: z
            .string()
            .optional()
            .describe('Only conversations for this contact.'),
          limit,
          cursor,
        },
        annotations: { ...READ, title: 'List conversations' },
      },
      handle(async (args) => api.listConversations(args))
    );
    note('list_conversations');

    server.registerTool(
      'get_conversation',
      {
        title: 'Get conversation',
        description:
          'Read a single conversation by id, including its contact and tags.',
        inputSchema: { id: z.string().describe('Conversation id.') },
        annotations: { ...READ, title: 'Get conversation' },
      },
      handle(async ({ id }) => api.getConversation(id))
    );
    note('get_conversation');
  }

  if (can('messages:read')) {
    server.registerTool(
      'list_messages',
      {
        title: 'List messages',
        description:
          "List a conversation's messages, newest first, with direction, delivery status and content. Paginated.",
        inputSchema: {
          conversation_id: z.string().describe('The conversation to read.'),
          limit,
          cursor,
        },
        annotations: { ...READ, title: 'List messages' },
      },
      handle(async ({ conversation_id, limit, cursor }) =>
        api.listConversationMessages(conversation_id, { limit, cursor })
      )
    );
    note('list_messages');
  }

  if (can('broadcasts:send')) {
    server.registerTool(
      'get_broadcast',
      {
        title: 'Get broadcast status',
        description:
          'Read a broadcast by id: status plus delivered / read / rejected counts. Use to poll progress after launching one.',
        inputSchema: { id: z.string().describe('Broadcast id.') },
        annotations: { ...READ, title: 'Get broadcast status' },
      },
      handle(async ({ id }) => api.getBroadcast(id))
    );
    note('get_broadcast');
  }

  if (can('contacts:write')) {
    server.registerTool(
      'create_contact',
      {
        title: 'Create contact',
        description:
          'Create a contact by phone (E.164, required). Find-or-create: an existing contact with that phone is returned unchanged. Optional: name, email, company, tags (names; created if missing).',
        inputSchema: {
          phone: z
            .string()
            .describe('Phone number in E.164 format, e.g. +14155550123.'),
          name: z.string().optional(),
          email: z.string().email().optional(),
          company: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
        annotations: { ...WRITE, title: 'Create contact' },
      },
      handle(async (args) => api.createContact(args))
    );
    note('create_contact');

    server.registerTool(
      'update_contact',
      {
        title: 'Update contact',
        description:
          "Update a contact. Only the fields you pass change. Passing tags REPLACES the contact's tags entirely.",
        inputSchema: {
          id: z.string().describe('Contact id.'),
          name: z.string().optional(),
          email: z.string().email().optional(),
          company: z.string().optional(),
          tags: z
            .array(z.string())
            .optional()
            .describe("Replaces the contact's tags."),
        },
        annotations: { ...WRITE, title: 'Update contact' },
      },
      handle(async ({ id, ...body }) => api.updateContact(id, body))
    );
    note('update_contact');
  }

  if (can('messages:send')) {
    server.registerTool(
      'send_message',
      {
        title: 'Send WhatsApp message',
        description:
          'Send a WhatsApp message to a phone number (E.164). Contact and conversation are found-or-created. Use type "text" for free-form (only valid inside the 24-hour customer-service window) or "template" for an approved template (required to open a new conversation). Media types need media_url. This sends a real message to a real person — confirm recipient and content with the user first.',
        inputSchema: {
          to: z.string().describe('Recipient phone number in E.164 format.'),
          type: z
            .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
            .default('text'),
          text: z
            .string()
            .optional()
            .describe('Body for "text", or caption for media.'),
          media_url: z
            .string()
            .url()
            .optional()
            .describe('Public URL of the media file.'),
          filename: z
            .string()
            .optional()
            .describe('File name for a "document" send.'),
          template: z
            .object({
              name: z.string().describe('Meta-approved template name.'),
              language: z.string().describe('Language code, e.g. "en_US".'),
              params: z
                .array(z.string())
                .optional()
                .describe('Positional body variables.'),
            })
            .optional()
            .describe('Required when type is "template".'),
          reply_to_message_id: z.string().optional(),
        },
        annotations: { ...WRITE, title: 'Send WhatsApp message' },
      },
      handle(async (args) => api.sendMessage(args))
    );
    note('send_message');
  }

  if (can('broadcasts:send')) {
    server.registerTool(
      'send_broadcast',
      {
        title: 'Send broadcast',
        description:
          'Launch a template broadcast to up to 1000 recipients. This sends real WhatsApp messages to everyone listed and cannot be undone. You MUST set confirm=true, and should show the user the full recipient list and template for approval first. Poll get_broadcast for progress.',
        inputSchema: {
          name: z.string().describe('Name for this campaign.'),
          template_name: z.string().describe('Meta-approved template name.'),
          template_language: z
            .string()
            .describe('Language code, e.g. "en_US".'),
          recipients: z
            .array(
              z.object({
                to: z.string().describe('Recipient phone in E.164 format.'),
                params: z.array(z.string()).optional(),
              })
            )
            .min(1)
            .max(1000),
          confirm: z.boolean().describe('Must be true to actually send.'),
        },
        annotations: {
          ...WRITE,
          title: 'Send broadcast',
          destructiveHint: true,
        },
      },
      async ({ confirm, ...body }): Promise<CallToolResult> => {
        if (confirm !== true) {
          return errorResult(
            `Refusing to send: confirm must be true. This would launch a mass broadcast to ${body.recipients.length} recipient(s). Confirm the recipients and template with the user, then call again with confirm=true.`
          );
        }
        return handle(async () => api.sendBroadcast(body))({});
      }
    );
    note('send_broadcast');
  }

  return registered;
}
