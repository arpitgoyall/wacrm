import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { submitMessageTemplate } from './meta-api'
import { buildMetaTemplatePayload } from './template-components'
import { normalizeStatus } from './template-status-normalize'
import { sendApprovedPendingMessage } from './pending-template-message'

export async function queueTemplateMessage(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  conversationId: string,
  text: string,
  replyToMessageId?: string,
): Promise<string> {
  const body = text.trim()
  if (!body || body.length > 1024) throw new Error('Message must be between 1 and 1024 characters.')
  const { data: config, error: configError } = await db.from('whatsapp_config')
    .select('waba_id, access_token').eq('account_id', accountId).single()
  if (configError || !config?.waba_id) throw new Error('WhatsApp account is not configured for templates.')

  const name = `inbox_${crypto.randomUUID().replaceAll('-', '')}`
  const { data: template, error: templateError } = await db.from('message_templates').insert({
    account_id: accountId, user_id: userId, name, category: 'Utility',
    language: 'en_US', body_text: body, status: 'PENDING',
  }).select('id').single()
  if (templateError || !template) throw new Error(templateError?.message ?? 'Could not save template')

  const { data: message, error: messageError } = await db.from('messages').insert({
    conversation_id: conversationId, sender_type: 'agent', sender_id: userId,
    content_type: 'text', content_text: body, template_name: name,
    reply_to_message_id: replyToMessageId ?? null,
    status: 'pending_approval',
  }).select('id').single()
  if (messageError || !message) {
    await db.from('message_templates').delete().eq('id', template.id)
    throw new Error(messageError?.message ?? 'Could not queue message')
  }
  await db.from('conversations').update({
    last_message_text: body, last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conversationId)

  try {
    const submitted = await submitMessageTemplate({
      wabaId: config.waba_id,
      accessToken: decrypt(config.access_token),
      payload: buildMetaTemplatePayload({
        name, category: 'Utility', language: 'en_US', body_text: body,
      }),
    })
    const status = normalizeStatus(submitted.status)
    const { error: updateError } = await db.from('message_templates').update({
      meta_template_id: submitted.id,
      last_submitted_at: new Date().toISOString(),
    }).eq('id', template.id)
    if (updateError) throw updateError
    // Preserve an earlier webhook's APPROVED/REJECTED outcome.
    const { data: current } = await db.from('message_templates')
      .select('status').eq('id', template.id).single()
    if (current?.status === 'PENDING') {
      await db.from('message_templates').update({ status }).eq('id', template.id).eq('status', 'PENDING')
    }
    if (status === 'APPROVED') await sendApprovedPendingMessage(db, name)
    if (status === 'REJECTED') await db.from('messages').update({ status: 'rejected' }).eq('id', message.id)
  } catch (error) {
    await db.from('messages').update({ status: 'failed' }).eq('id', message.id)
    await db.from('message_templates').update({
      status: 'DRAFT', submission_error: error instanceof Error ? error.message : 'Submission failed',
    }).eq('id', template.id)
    throw error
  }
  return message.id
}
