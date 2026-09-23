import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveConversationForContact } = vi.hoisted(() => ({
  resolveConversationForContact: vi.fn(async () => 'conv-1'),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationForContact,
}));

import { persistBroadcastMessage } from './broadcast-inbox';

function harness(existing = false) {
  const inserted: Record<string, unknown>[] = [];
  const conversationUpdates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({
                  data: existing ? [{ id: 'message-1' }] : [],
                  error: null,
                }),
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      return {
        update: (row: Record<string, unknown>) => ({
          eq: async () => {
            conversationUpdates.push(row);
            return { error: null };
          },
        }),
      };
    },
  };
  return { db, inserted, conversationUpdates };
}

describe('persistBroadcastMessage', () => {
  beforeEach(() => resolveConversationForContact.mockClear());

  it('creates a rendered template bubble and updates the conversation preview', async () => {
    const h = harness();
    await persistBroadcastMessage(h.db as never, {
      accountId: 'account-1',
      auditUserId: 'owner-1',
      contactId: 'contact-1',
      whatsappMessageId: 'wamid-1',
      templateName: 'follow_up',
      params: ['Arpit'],
      template: {
        body_text: 'Hello {{1}}',
        header_type: 'image',
        header_media_url: 'https://example.com/default.jpg',
      } as never,
      headerMediaUrl: 'https://example.com/campaign.jpg',
    });

    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      conversation_id: 'conv-1',
      content_type: 'template',
      content_text: 'Hello Arpit',
      media_url: 'https://example.com/campaign.jpg',
      template_name: 'follow_up',
      message_id: 'wamid-1',
      status: 'sent',
    });
    expect(h.conversationUpdates[0]).toMatchObject({
      last_message_text: 'Hello Arpit',
    });
  });

  it('does not insert a duplicate bubble for an existing Meta message id', async () => {
    const h = harness(true);
    await persistBroadcastMessage(h.db as never, {
      accountId: 'account-1',
      auditUserId: 'owner-1',
      contactId: 'contact-1',
      whatsappMessageId: 'wamid-1',
      templateName: 'follow_up',
      params: [],
      template: null,
    });

    expect(h.inserted).toHaveLength(0);
    expect(h.conversationUpdates).toHaveLength(1);
  });
});
