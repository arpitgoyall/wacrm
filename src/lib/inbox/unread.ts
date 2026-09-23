/**
 * A conversation's unread counter belongs to its assigned agent. Other
 * account members may inspect or reply to the thread, but doing so must not
 * consume the assignee's unread state. Unassigned conversations remain a
 * shared queue, so whichever member opens one may clear it.
 */
export function canClearConversationUnread(
  userId: string | null | undefined,
  assignedAgentId: string | null | undefined
): boolean {
  return Boolean(userId) && (!assignedAgentId || assignedAgentId === userId);
}
