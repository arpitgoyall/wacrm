import type { SupabaseClient } from '@supabase/supabase-js';

import type { MessageTemplate } from '@/types';
import { resolveConversationForContact } from '@/lib/whatsapp/resolve-conversation';
import { templateContentText } from '@/lib/whatsapp/template-body';

interface PersistBroadcastMessageArgs {
  accountId: string;
  auditUserId: string;
  contactId: string;
  whatsappMessageId: string;
  templateName: string;
  params: string[];
  template: MessageTemplate | null;
  /** Per-send media header overrides the template's stored sample URL. */
  headerMediaUrl?: string;
}

/** Mirror a successful Meta broadcast send into the shared inbox. */
export async function persistBroadcastMessage(
  db: SupabaseClient,
  args: PersistBroadcastMessageArgs
): Promise<void> {
  const conversationId = await resolveConversationForContact(
    db,
    args.accountId,
    args.contactId,
    args.auditUserId
  );
  const contentText = templateContentText(args.template, args.params);
  const storedHeaderUrl = args.template?.header_media_url?.trim();
  const storedHandle = args.template?.header_handle?.trim();
  const mediaUrl =
    args.headerMediaUrl?.trim() ||
    storedHeaderUrl ||
    (storedHandle && /^https?:\/\//i.test(storedHandle) ? storedHandle : null);
  const sentAt = new Date().toISOString();

  // Idempotent on the conversation + Meta id so resume/retry cannot create
  // a second bubble for the same successful WhatsApp send.
  const { data: existing, error: lookupError } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', args.whatsappMessageId)
    .limit(1);
  if (lookupError) throw lookupError;

  if (!existing || existing.length === 0) {
    const { error: insertError } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'template',
      content_text: contentText,
      media_url: mediaUrl,
      media_type: args.template?.header_type ?? null,
      template_name: args.templateName,
      message_id: args.whatsappMessageId,
      status: 'sent',
      created_at: sentAt,
    });
    if (insertError) throw insertError;
  }

  const { error: conversationError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText ?? `[template:${args.templateName}]`,
      last_message_at: sentAt,
      updated_at: sentAt,
    })
    .eq('id', conversationId);
  if (conversationError) throw conversationError;
}
