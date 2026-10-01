import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { sendTemplateMessage } from './meta-api'
import { sanitizePhoneForMeta } from './phone-utils'

/** Claim a queued message before making the external send, so duplicate webhooks cannot send twice. */
export async function sendApprovedPendingMessage(
  db: SupabaseClient,
  templateName: string,
): Promise<void> {
  const { data: pending } = await db
    .from('messages')
    .select('id, conversation_id')
    .eq('template_name', templateName)
    .eq('status', 'pending_approval')
  for (const message of pending ?? []) {
    const { data: claimed, error: claimError } = await db
      .from('messages')
      .update({ status: 'sending' })
      .eq('id', message.id)
      .eq('status', 'pending_approval')
      .select('id')
      .maybeSingle()
    if (claimError || !claimed) continue
    try {
      const { data: conversation, error: conversationError } = await db
        .from('conversations')
        .select('account_id, contact:contacts(phone)')
        .eq('id', message.conversation_id)
        .single()
      if (conversationError || !conversation) throw new Error('Conversation unavailable')
      const { data: config, error: configError } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', conversation.account_id)
        .single()
      if (configError || !config) throw new Error('WhatsApp configuration unavailable')
      const contact = conversation.contact as unknown as { phone: string } | null
      if (!contact?.phone) throw new Error('Contact phone unavailable')
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        to: sanitizePhoneForMeta(contact.phone),
        templateName,
        language: 'en_US',
      })
      await db.from('messages').update({ status: 'sent', message_id: result.messageId })
        .eq('id', message.id).eq('status', 'sending')
    } catch (error) {
      console.error('[pending-template] send failed', message.id, error)
      await db.from('messages').update({ status: 'failed' }).eq('id', message.id)
    }
  }
}
