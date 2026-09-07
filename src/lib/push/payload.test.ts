import { describe, it, expect } from 'vitest';
import { notificationToPushPayload } from './payload';

describe('notificationToPushPayload', () => {
  it('deep-links to the conversation and collapses on its id', () => {
    const p = notificationToPushPayload({
      id: 'n1',
      type: 'new_message',
      title: 'New message from Asha',
      body: 'Is it still available?',
      conversation_id: 'c-123',
    });
    expect(p).toEqual({
      title: 'New message from Asha',
      body: 'Is it still available?',
      url: '/inbox?c=c-123',
      tag: 'conversation-c-123',
      type: 'new_message',
      notificationId: 'n1',
    });
  });

  it('falls back to the notifications page and a per-row tag when there is no conversation', () => {
    const p = notificationToPushPayload({
      id: 'n2',
      type: 'sla_breach',
      title: 'Follow-up overdue',
      body: null,
      conversation_id: null,
    });
    expect(p.url).toBe('/notifications');
    expect(p.tag).toBe('notification-n2');
    expect(p.body).toBe('');
  });

  it('url-encodes the conversation id', () => {
    const p = notificationToPushPayload({
      id: 'n3',
      type: 'conversation_assigned',
      title: 'x',
      body: null,
      conversation_id: 'a b/c',
    });
    expect(p.url).toBe('/inbox?c=a%20b%2Fc');
  });

  it('never emits an empty title', () => {
    const p = notificationToPushPayload({
      id: 'n4',
      type: 'new_message',
      title: '',
      body: null,
      conversation_id: null,
    });
    expect(p.title).toBe('New notification');
  });
});
