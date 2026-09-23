import { describe, expect, it } from 'vitest';
import { canClearConversationUnread } from './unread';

describe('canClearConversationUnread', () => {
  it('lets the assigned agent clear the unread counter', () => {
    expect(canClearConversationUnread('agent-1', 'agent-1')).toBe(true);
  });

  it('preserves unread state when another member views or replies', () => {
    expect(canClearConversationUnread('owner-1', 'agent-1')).toBe(false);
  });

  it('lets a signed-in member clear an unassigned queue item', () => {
    expect(canClearConversationUnread('owner-1', null)).toBe(true);
  });

  it('does not clear anything before the current user is known', () => {
    expect(canClearConversationUnread(undefined, 'agent-1')).toBe(false);
  });
});
