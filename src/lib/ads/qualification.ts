import { supabaseAdmin } from '@/lib/automations/admin-client';
import { evaluateQualification, type BusinessRules } from './outcomes';

export async function evaluateWorkspaceRules(accountId?: string) {
  const db = supabaseAdmin();
  let queueQuery = db
    .from('ads_rule_queue')
    .select('*')
    .order('dirty_at')
    .limit(20);
  if (accountId) queueQuery = queueQuery.eq('account_id', accountId);
  const { data: queue, error } = await queueQuery;
  if (error) return { processed: 0, unavailable: true };
  let processed = 0;
  for (const item of queue || []) {
    const [definition, contact, previous, deals, flow, custom] =
      await Promise.all([
        db
          .from('ads_documents')
          .select('data')
          .eq('account_id', item.account_id)
          .eq('kind', 'rules')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from('contacts')
          .select('*')
          .eq('account_id', item.account_id)
          .eq('id', item.contact_id)
          .maybeSingle(),
        db
          .from('ads_qualifications')
          .select('*')
          .eq('account_id', item.account_id)
          .eq('contact_id', item.contact_id)
          .order('occurred_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from('deals')
          .select('stage_id')
          .eq('account_id', item.account_id)
          .eq('contact_id', item.contact_id),
        db
          .from('flow_runs')
          .select('vars')
          .eq('account_id', item.account_id)
          .eq('contact_id', item.contact_id)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from('contact_custom_values')
          .select('custom_field_id,value')
          .eq('contact_id', item.contact_id),
      ]);
    if (
      [definition, contact, previous, deals, flow, custom].some((r) => r.error)
    )
      continue;
    const rules = definition.data?.data as BusinessRules | undefined;
    if (
      rules?.enabled &&
      rules.effectiveAt &&
      Date.parse(item.dirty_at) >= Date.parse(rules.effectiveAt) &&
      contact.data &&
      previous.data?.source !== 'staff'
    ) {
      const facts = {
        contact: {
          ...contact.data,
          ...Object.fromEntries(
            (custom.data || []).map((c) => [c.custom_field_id, c.value])
          ),
        },
        answer: flow.data?.vars || {},
        stage: (deals.data || []).map((d) => String(d.stage_id)),
      };
      const matchedStage = facts.stage.some((s) =>
        rules.qualifiedStages?.includes(s)
      );
      const matched =
        matchedStage ||
        evaluateQualification(rules.rules || [], facts, rules.match || 'all');
      if (matched && previous.data?.status !== 'qualified') {
        const { error: saveError } = await db
          .from('ads_qualifications')
          .insert({
            account_id: item.account_id,
            contact_id: item.contact_id,
            status: 'qualified',
            source: 'rule',
            reason: matchedStage
              ? 'Business qualification stage reached'
              : 'Business qualification rules matched',
          });
        if (saveError) continue;
      }
    }
    const { error: deleteError } = await db
      .from('ads_rule_queue')
      .delete()
      .eq('id', item.id)
      .eq('dirty_at', item.dirty_at);
    if (!deleteError) processed++;
  }
  return { processed };
}
