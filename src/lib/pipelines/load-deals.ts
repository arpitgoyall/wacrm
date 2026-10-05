import type { SupabaseClient } from '@supabase/supabase-js';
import type { Deal } from '@/types';

// Supabase caps query results at 1,000 by default. Fetch every page so a
// bulk-transfer selection does not silently omit older leads.
export async function loadPipelineDeals(
  supabase: SupabaseClient,
  pipelineId: string
): Promise<Deal[]> {
  const rows: Deal[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('deals')
      .select(
        '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)'
      )
      .eq('pipeline_id', pipelineId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Deal[]));
    if (!data || data.length < 1000) break;
  }

  const contactIds = [
    ...new Set(
      rows.flatMap((deal) => (deal.contact_id ? [deal.contact_id] : []))
    ),
  ];
  const conversationByContact = new Map<string, string>();
  // One conversation per account/contact is enforced by migration 036.
  // Bound the IN filters so they stay below the result and URL caps too.
  for (let offset = 0; offset < contactIds.length; offset += 200) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .in('contact_id', contactIds.slice(offset, offset + 200))
      .order('last_message_at', { ascending: false });
    if (error) throw new Error(error.message);
    for (const conversation of data ?? []) {
      if (
        conversation.contact_id &&
        !conversationByContact.has(conversation.contact_id)
      ) {
        conversationByContact.set(conversation.contact_id, conversation.id);
      }
    }
  }
  return rows.map((deal) => ({
    ...deal,
    conversation_id:
      (deal.contact_id
        ? conversationByContact.get(deal.contact_id)
        : undefined) ?? deal.conversation_id,
  }));
}
