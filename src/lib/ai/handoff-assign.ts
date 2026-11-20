import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * Pick who an AI handoff goes to when no fixed handoff agent is configured:
 * the least-busy agent, i.e. the one with the fewest open (non-closed)
 * assigned conversations, ties broken at random. Plain `agent` members are
 * preferred; admins/owners are only used when the account has no agents.
 * Returns null if nobody is available.
 */
export async function pickHandoffAgent(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  for (const roles of [['agent'], ['admin', 'owner']]) {
    const { data: members } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', roles)
    const ids = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id)
    if (ids.length === 0) continue

    const loads = await Promise.all(
      ids.map(async (id) => {
        const { count } = await db
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('assigned_agent_id', id)
          .neq('status', 'closed')
        return { id, load: count ?? 0 }
      }),
    )
    const min = Math.min(...loads.map((l) => l.load))
    const lightest = loads.filter((l) => l.load === min)
    return lightest[Math.floor(Math.random() * lightest.length)].id
  }
  return null
}

/**
 * Fire the account's `conversation_assigned` automations for an assignment
 * the AI just made. The assign API route does this itself; a direct DB
 * update does not, so without this call an automation like "send the
 * counsellor intro when a chat is assigned" would never run for AI
 * handoffs. Context mirrors /api/conversations/[id]/assignment.
 */
export async function fireConversationAssigned(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    agentId: string
  },
): Promise<void> {
  const { accountId, conversationId, contactId, agentId } = args
  const [{ data: counselor }, { data: contact }] = await Promise.all([
    db
      .from('profiles')
      .select('full_name, profile_card')
      .eq('account_id', accountId)
      .eq('user_id', agentId)
      .maybeSingle(),
    db
      .from('contacts')
      .select('name, phone, email, company')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle(),
  ])
  const counselorName = counselor?.full_name ?? ''
  await runAutomationsForTrigger({
    accountId,
    triggerType: 'conversation_assigned',
    contactId,
    context: {
      conversation_id: conversationId,
      agent_id: agentId,
      customer_name: contact?.name ?? '',
      counselor_name: counselorName,
      counselor_profile_card_url: counselor?.profile_card ?? '',
      contact: contact ?? undefined,
      vars: {
        customer_name: contact?.name ?? '',
        counselor_name: counselorName,
      },
    },
  })
}
