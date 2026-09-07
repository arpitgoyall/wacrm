import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

// POST /api/notifications/read  { conversation_id }
//
// Marks the caller's unread message / new-conversation notifications
// for one conversation as read, and clears its inbox unread count.
// Used by the service worker's "Mark as read" notification action
// (the SW request carries the session cookie) and can be called from
// the app too.

export async function POST(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount();
    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body.conversation_id === 'string'
        ? body.conversation_id
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id required' },
        { status: 400 },
      );
    }

    // RLS: the `notifications_update` policy allows a recipient to set
    // `read_at` on their own rows; `conversations` update is gated by
    // account membership.
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .in('type', ['new_message', 'new_conversation'])
      .is('read_at', null);

    await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
