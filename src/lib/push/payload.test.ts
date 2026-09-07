import { describe, it, expect } from 'vitest';
import { notificationToPushPayload } from './payload';

describe('notificationToPushPayload', () => {
  it('shapes a message alert like WhatsApp: contact name + avatar', () => {
    const p = notificationToPushPayload(
      {
        id: 'n1',
        type: 'new_message',
        title: 'New message from Asha',
        body: 'Is it still available?',
        conversation_id: 'c-123',
      },
      { name: 'Asha Rao', avatar_url: 'https://cdn.example/asha.jpg' },
    );
    expect(p).toEqual({
      title: 'Asha Rao',
      body: 'Is it still available?',
      icon: 'https://cdn.example/asha.jpg',
      url: '/inbox?c=c-123',
      tag: 'conversation-c-123',
      type: 'new_message',
      notificationId: 'n1',
      conversationId: 'c-123',
    });
  });

  it('message alert falls back to the row title + app icon with no contact', () => {
    const p = notificationToPushPayload({
      id: 'n1',
      type: 'new_message',
      title: 'New message from Asha',
      body: 'hi',
      conversation_id: 'c-1',
    });
    expect(p.title).toBe('New message from Asha');
    expect(p.icon).toBe('/icon-192.png');
  });

  it('non-message alerts keep the row copy and app icon', () => {
    const p = notificationToPushPayload(
      {
        id: 'n2',
        type: 'conversation_assigned',
        title: 'New conversation assigned',
        body: 'Priya assigned you a chat',
        conversation_id: 'c-9',
      },
      { name: 'Whoever', avatar_url: 'https://cdn.example/x.jpg' },
    );
    expect(p.title).toBe('New conversation assigned');
    expect(p.icon).toBe('/icon-192.png');
    expect(p.conversationId).toBe('c-9');
  });

  it('falls back to the notifications page and a per-row tag with no conversation', () => {
    const p = notificationToPushPayload({
      id: 'n3',
      type: 'sla_breach',
      title: 'Reply overdue',
      body: null,
      conversation_id: null,
    });
    expect(p.url).toBe('/notifications');
    expect(p.tag).toBe('notification-n3');
    expect(p.body).toBe('');
    expect(p.conversationId).toBeNull();
  });

  it('url-encodes the conversation id', () => {
    const p = notificationToPushPayload({
      id: 'n4',
      type: 'new_message',
      title: 'x',
      body: null,
      conversation_id: 'a b/c',
    });
    expect(p.url).toBe('/inbox?c=a%20b%2Fc');
  });

  it('never emits an empty title', () => {
    const p = notificationToPushPayload({
      id: 'n5',
      type: 'new_message',
      title: '',
      body: null,
      conversation_id: null,
    });
    expect(p.title).toBe('New notification');
  });
});
