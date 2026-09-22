import { NextResponse } from 'next/server'

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id
  if (agentId !== null && typeof agentId !== 'string') {
    return NextResponse.json({ error: 'agent_id must be a string or null' }, { status: 400 })
  }

  const { data: conversation, error: conversationError } = await ctx.supabase
    .from('conversations')
    .select('id, contact_id, assigned_agent_id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (conversationError) {
    return NextResponse.json({ error: conversationError.message }, { status: 500 })
  }
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  let counselorName = ''
  if (agentId) {
    const { data: counselor, error: counselorError } = await ctx.supabase
      .from('profiles')
      .select('full_name')
      .eq('account_id', ctx.accountId)
      .eq('user_id', agentId)
      .maybeSingle()
    if (counselorError) {
      return NextResponse.json({ error: counselorError.message }, { status: 500 })
    }
    if (!counselor) {
      return NextResponse.json({ error: 'Counselor is not a member of this account' }, { status: 400 })
    }
    counselorName = counselor.full_name ?? ''
  }

  const { error: updateError } = await ctx.supabase
    .from('conversations')
    .update({ assigned_agent_id: agentId })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  if (agentId && agentId !== conversation.assigned_agent_id) {
    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('name')
      .eq('id', conversation.contact_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    await runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: 'conversation_assigned',
      contactId: conversation.contact_id,
      context: {
        conversation_id: conversation.id,
        agent_id: agentId,
        customer_name: contact?.name ?? '',
        counselor_name: counselorName,
        vars: {
          customer_name: contact?.name ?? '',
          counselor_name: counselorName,
        },
      },
    })
  }

  return NextResponse.json({ ok: true, assigned_agent_id: agentId })
}
