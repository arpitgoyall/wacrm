import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendCtwaConversion } from '@/lib/automations/ctwa-capi'

const IMMEDIATE_RETRY_DELAYS_MS = [0, 250, 750] as const

export type BuiltInMetaEvent = 'LeadSubmitted' | 'Purchase'

export function metaEventForStage(stageName: string): BuiltInMetaEvent | null {
  switch (stageName.trim().toLowerCase()) {
    case 'qualified':
      return 'LeadSubmitted'
    case 'enrolled':
      return 'Purchase'
    default:
      return null
  }
}

export type DealStageConversionResult =
  | { status: 'sent'; eventName: BuiltInMetaEvent; responseStatus: number }
  | { status: 'skipped'; reason: string; eventName?: BuiltInMetaEvent }
  | { status: 'failed'; error: string; eventName?: BuiltInMetaEvent }

export async function dispatchBuiltInDealStageConversion(
  eventId: string,
): Promise<DealStageConversionResult> {
  const db = supabaseAdmin()
  const { data: event, error: eventError } = await db
    .from('deal_stage_events')
    .select('id, account_id, deal_id, to_stage_id, created_at')
    .eq('id', eventId)
    .maybeSingle()

  if (eventError) return { status: 'failed', error: eventError.message }
  if (!event) return { status: 'failed', error: 'stage-change event not found' }

  const { data: stage, error: stageError } = await db
    .from('pipeline_stages')
    .select('name')
    .eq('id', event.to_stage_id)
    .maybeSingle()
  if (stageError) return { status: 'failed', error: stageError.message }
  if (!stage) return { status: 'failed', error: 'destination stage not found' }

  const eventName = metaEventForStage(stage.name as string)
  if (!eventName) {
    return { status: 'skipped', reason: `stage "${stage.name}" has no built-in Meta event` }
  }

  const { data: deal, error: dealError } = await db
    .from('deals')
    .select('id, contact_id, value, ctwa_clid')
    .eq('id', event.deal_id)
    .eq('account_id', event.account_id)
    .maybeSingle()
  if (dealError) return { status: 'failed', error: dealError.message, eventName }
  if (!deal) return { status: 'failed', error: 'deal not found', eventName }

  let ctwaClid = (deal.ctwa_clid as string | null) ?? null
  if (!ctwaClid && deal.contact_id) {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', deal.contact_id)
      .eq('account_id', event.account_id)
      .maybeSingle()
    if (contactError) return { status: 'failed', error: contactError.message, eventName }
    ctwaClid = (contact?.ctwa_clid as string | null) ?? null
  }
  if (!ctwaClid) {
    return {
      status: 'skipped',
      reason: 'deal has no CTWA click id',
      eventName,
    }
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waba_id, ctwa_dataset_id, ctwa_capi_token')
    .eq('account_id', event.account_id)
    .maybeSingle()
  if (configError) return { status: 'failed', error: configError.message, eventName }
  if (!config?.waba_id || !config.ctwa_dataset_id || !config.ctwa_capi_token) {
    return {
      status: 'skipped',
      reason: 'account has no complete Meta Conversions API configuration',
      eventName,
    }
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.ctwa_capi_token as string)
  } catch {
    return { status: 'failed', error: 'stored Meta CAPI token cannot be decrypted', eventName }
  }

  const { error: guardError } = await db.from('ctwa_conversion_dispatches').insert({
    account_id: event.account_id,
    deal_id: event.deal_id,
    stage_id: event.to_stage_id,
    event_name: eventName,
    ctwa_clid: ctwaClid,
  })
  if (guardError) {
    const message = guardError.message ?? ''
    if (message.includes('23505') || message.includes('duplicate key')) {
      return { status: 'skipped', reason: 'conversion already sent', eventName }
    }
    return { status: 'failed', error: `dispatch guard failed: ${message}`, eventName }
  }

  let finalError = 'Meta Conversions API request failed'
  for (const delayMs of IMMEDIATE_RETRY_DELAYS_MS) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))

    const result = await sendCtwaConversion({
      datasetId: config.ctwa_dataset_id as string,
      accessToken,
      wabaId: config.waba_id as string,
      ctwaClid,
      eventName,
      eventTime: Math.floor(new Date(event.created_at as string).getTime() / 1000),
      eventId: `${event.deal_id}:${event.to_stage_id}:${eventName}`,
      value: eventName === 'Purchase' ? Number(deal.value ?? 0) : undefined,
      currency: eventName === 'Purchase' ? 'INR' : undefined,
      partnerAgent: 'wacrm',
    })

    if (result.ok) {
      await db
        .from('ctwa_conversion_dispatches')
        .update({ response_status: result.status })
        .eq('deal_id', event.deal_id)
        .eq('stage_id', event.to_stage_id)
        .eq('event_name', eventName)
      return { status: 'sent', eventName, responseStatus: result.status }
    }
    finalError = `Meta Conversions API returned ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`
  }

  await db
    .from('ctwa_conversion_dispatches')
    .delete()
    .eq('deal_id', event.deal_id)
    .eq('stage_id', event.to_stage_id)
    .eq('event_name', eventName)

  return { status: 'failed', error: finalError, eventName }
}
