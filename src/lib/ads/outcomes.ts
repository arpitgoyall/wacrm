import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { graph } from './graph';

export interface QualificationRule {
  source: 'contact' | 'answer' | 'stage';
  field: string;
  operator: 'equals' | 'contains' | 'gte' | 'exists';
  value: string;
}
export interface BusinessRules {
  effectiveAt?: string;
  qualifiedStages?: string[];
  saleStages?: string[];
  rules?: QualificationRule[];
  match?: 'all' | 'any';
  enabled?: boolean;
}
export function evaluateQualification(
  rules: QualificationRule[],
  facts: {
    contact: Record<string, unknown>;
    answer: Record<string, unknown>;
    stage: string[];
  },
  match: 'all' | 'any'
) {
  if (!rules.length) return false;
  const result = rules.map((rule) => {
    const actual =
      rule.source === 'stage' ? facts.stage : facts[rule.source][rule.field];
    if (rule.operator === 'exists')
      return (
        actual !== null &&
        actual !== undefined &&
        actual !== '' &&
        (!Array.isArray(actual) || actual.length > 0)
      );
    if (actual === null || actual === undefined || actual === '') return false;
    if (rule.operator === 'contains')
      return Array.isArray(actual)
        ? actual.map(String).includes(rule.value)
        : String(actual ?? '')
            .toLowerCase()
            .includes(rule.value.toLowerCase());
    if (rule.operator === 'gte')
      return (
        actual !== null &&
        actual !== undefined &&
        actual !== '' &&
        Number.isFinite(Number(actual)) &&
        Number(actual) >= Number(rule.value)
      );
    return Array.isArray(actual)
      ? actual.map(String).includes(rule.value)
      : String(actual).toLowerCase() === rule.value.toLowerCase();
  });
  return match === 'all' ? result.every(Boolean) : result.some(Boolean);
}
export async function drainConversionEvents(limit = 10) {
  const db = supabaseAdmin(),
    now = new Date().toISOString();
  // Reclaim crashed workers; stable event IDs keep downstream retries idempotent.
  await db
    .from('ads_conversion_events')
    .update({
      status: 'failed',
      reason:
        'Previous delivery was interrupted; eligible retries resume automatically',
    })
    .eq('status', 'processing')
    .lt('claimed_at', new Date(Date.now() - 300_000).toISOString());
  const { data, error } = await db
    .from('ads_conversion_events')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lt('attempt_count', 8)
    .lte('next_attempt_at', now)
    .order('next_attempt_at')
    .limit(limit);
  if (error) return { processed: 0, unavailable: true };
  let processed = 0;
  for (const event of data || []) {
    const { data: claim } = await db
      .from('ads_conversion_events')
      .update({
        status: 'processing',
        claimed_at: now,
        attempt_count: event.attempt_count + 1,
      })
      .eq('id', event.id)
      .eq('status', event.status)
      .eq('attempt_count', event.attempt_count)
      .select('id')
      .maybeSingle();
    if (!claim) continue;
    let status = 'failed',
      reason: string | null = null,
      responseStatus = 0;
    try {
      const sale =
        event.event_name === 'Purchase'
          ? await db
              .from('ads_sales')
              .select('status')
              .eq('account_id', event.account_id)
              .eq('id', String(event.outcome_key).replace(/^sale:/, ''))
              .maybeSingle()
          : null;
      if (sale?.error) throw sale.error;
      const { data: config } = await db
        .from('whatsapp_config')
        .select('waba_id,ctwa_dataset_id,ctwa_capi_token')
        .eq('account_id', event.account_id)
        .maybeSingle();
      if (
        event.event_name === 'Purchase' &&
        sale?.data?.status !== 'confirmed'
      ) {
        status = 'skipped';
        reason = 'Sale is no longer confirmed; no Purchase event was sent';
      } else if (!event.ctwa_clid) {
        status = 'skipped';
        reason = 'No WhatsApp ad click identifier is available';
      } else if (
        !config?.ctwa_dataset_id ||
        !config.ctwa_capi_token ||
        !config.waba_id
      ) {
        status = 'skipped';
        reason =
          'Configure the WhatsApp dataset and conversion token in Settings';
      } else {
        const result = await graph<{ events_received?: number }>(
          `${config.ctwa_dataset_id}/events`,
          decrypt(config.ctwa_capi_token),
          {
            data: [
              {
                event_name: event.event_name,
                event_id: event.id,
                event_time: Math.floor(Date.parse(event.occurred_at) / 1000),
                action_source: 'business_messaging',
                messaging_channel: 'whatsapp',
                user_data: {
                  ctwa_clid: event.ctwa_clid,
                  whatsapp_business_account_id: config.waba_id,
                },
                ...(event.event_name === 'Purchase'
                  ? {
                      custom_data: {
                        value: event.value,
                        currency: event.currency,
                      },
                    }
                  : {}),
              },
            ],
          },
          'POST'
        );
        responseStatus = 200;
        if (!(Number(result.events_received) >= 1))
          throw Error('Meta did not confirm receiving the event');
        status = 'delivered';
      }
    } catch (err) {
      reason =
        err instanceof Error
          ? err.message.slice(0, 500)
          : 'Conversion delivery failed';
    }
    const { error: attemptError } = await db
      .from('ads_conversion_attempts')
      .insert({
        account_id: event.account_id,
        event_id: event.id,
        status: responseStatus,
        accepted: status === 'delivered',
        reason,
      });
    if (attemptError)
      reason = reason || 'Delivery attempt log could not be saved';
    await db
      .from('ads_conversion_events')
      .update({
        status,
        reason,
        delivered_at: status === 'delivered' ? new Date().toISOString() : null,
        next_attempt_at: new Date(
          Date.now() + Math.min(86400_000, 60_000 * 2 ** event.attempt_count)
        ).toISOString(),
      })
      .eq('id', event.id);
    processed++;
  }
  return { processed };
}

export async function queueStageOutcome(eventId: string) {
  const db = supabaseAdmin();
  const { data: event } = await db
    .from('deal_stage_events')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  if (!event)
    return { status: 'skipped' as const, reason: 'Stage event not found' };
  const { data: definition } = await db
    .from('ads_documents')
    .select('data')
    .eq('account_id', event.account_id)
    .eq('kind', 'rules')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const rules = definition?.data as BusinessRules | undefined;
  if (!rules?.enabled)
    return {
      status: 'skipped' as const,
      reason: 'Configure and enable workspace conversion mappings',
    };
  if (
    !rules.effectiveAt ||
    Date.parse(event.created_at) < Date.parse(rules.effectiveAt)
  )
    return {
      status: 'skipped' as const,
      reason: 'Stage event predates the current conversion rules',
    };
  const { data: deal } = await db
    .from('deals')
    .select('id,contact_id,value,currency')
    .eq('account_id', event.account_id)
    .eq('id', event.deal_id)
    .maybeSingle();
  if (!deal) return { status: 'skipped' as const, reason: 'Deal not found' };
  if (rules.qualifiedStages?.includes(event.to_stage_id)) {
    const { data: previous } = await db
      .from('ads_qualifications')
      .select('id,status,source')
      .eq('account_id', event.account_id)
      .eq('contact_id', deal.contact_id)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous?.source !== 'staff' && previous?.status !== 'qualified') {
      const { error } = await db.from('ads_qualifications').insert({
        account_id: event.account_id,
        contact_id: deal.contact_id,
        status: 'qualified',
        source: 'rule',
        reason: `Mapped pipeline stage ${event.to_stage_id}`,
        occurred_at: event.created_at,
      });
      if (error) throw error;
    }
  }
  if (rules.saleStages?.includes(event.to_stage_id)) {
    const { error } = await db.rpc('ads_confirm_sale', {
      p_account: event.account_id,
      p_contact: deal.contact_id,
      p_deal: deal.id,
      p_key: `deal:${deal.id}`,
      p_value: deal.value,
      p_currency: deal.currency,
      p_source: 'staff',
      p_status: 'confirmed',
      p_actor: null,
      p_time: event.created_at,
    });
    if (error) throw error;
  }
  return {
    status: 'skipped' as const,
    reason:
      'Workspace outcome recorded; eligible events are delivered by the durable conversion queue',
  };
}
