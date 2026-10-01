import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { deleteMessageTemplate } from './meta-api'
import { isTemporaryTemplateName } from './temporary-template-name'

/** Keep the sent message and its receipt history; remove only the one-use template. */
export async function deleteDeliveredTemporaryTemplate(
  db: SupabaseClient,
  accountId: string,
  name: string,
): Promise<void> {
  if (!isTemporaryTemplateName(name)) return

  const { data: template, error: templateError } = await db
    .from('message_templates')
    .select('id, meta_template_id')
    .eq('account_id', accountId)
    .eq('name', name)
    .maybeSingle()
  if (templateError) throw templateError
  if (!template?.meta_template_id) return

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waba_id, access_token')
    .eq('account_id', accountId)
    .single()
  if (configError || !config?.waba_id) throw configError ?? new Error('WhatsApp account unavailable')

  await deleteMessageTemplate({
    wabaId: config.waba_id,
    accessToken: decrypt(config.access_token),
    name,
    metaTemplateId: template.meta_template_id,
  })
  const { error: deleteError } = await db.from('message_templates').delete().eq('id', template.id)
  if (deleteError) throw deleteError
}
