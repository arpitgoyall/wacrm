import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { startManualFlowRun } from '@/lib/flows/engine'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import type { FlowRow } from '@/lib/flows/types'

/**
 * POST /api/flows/[id]/run
 *
 * Body: { contact_id: string }
 *
 * Owner-only, on-demand flow start against a chosen contact — used by
 * the flow editor's "Run manually" action. Any *active* flow is
 * eligible regardless of its configured trigger type; the trigger
 * type only governs automatic dispatch from inbound messages
 * (`findEntryFlow` in the engine), which this route bypasses entirely.
 *
 * A contact with an existing active run (for this flow or any other)
 * is refused — no auto-override. See `idx_one_active_run_per_contact`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  // Stricter than activation (`requireRole('admin')`) — this sends a
  // live message to a real customer on demand, not just a config change.
  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('owner')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId, userId } = ctx

  const body = (await request.json().catch(() => null)) as
    | { contact_id?: string }
    | null
  const contactId = body?.contact_id
  if (!contactId) {
    return NextResponse.json(
      { error: 'contact_id is required' },
      { status: 400 },
    )
  }

  // Ownership via RLS — caller's client, clean 404 for a flow outside
  // the caller's account.
  const { data: flow } = await supabase
    .from('flows')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (flow.status !== 'active') {
    return NextResponse.json(
      { error: 'Only an active flow can be run manually.' },
      { status: 422 },
    )
  }
  if (!flow.entry_node_id) {
    // Defense-in-depth: activation validation guarantees this at the
    // moment of activation, but nodes can be edited afterward without
    // re-validating.
    return NextResponse.json(
      { error: 'This flow has no entry node configured.' },
      { status: 422 },
    )
  }

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }
  if (!contact.phone) {
    return NextResponse.json(
      { error: 'This contact has no phone number on file.' },
      { status: 422 },
    )
  }

  const admin = supabaseAdmin()

  // Friendly pre-check — the INSERT inside startManualFlowRun is the
  // actual race-safety net (idx_one_active_run_per_contact) if this
  // check and a concurrent trigger interleave.
  const { data: activeRun } = await admin
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .maybeSingle()
  if (activeRun) {
    return NextResponse.json(
      {
        error:
          'This contact already has an active flow run in progress. End it before starting a new one.',
      },
      { status: 409 },
    )
  }

  const conversationId = await findOrCreateConversation(
    supabase,
    accountId,
    userId,
    contactId,
  )
  if (!conversationId) {
    return NextResponse.json(
      { error: 'Failed to open a conversation for this contact' },
      { status: 500 },
    )
  }

  try {
    const result = await startManualFlowRun(admin, flow as FlowRow, {
      accountId,
      userId,
      contactId,
      conversationId,
    })

    if (result.outcome === 'duplicate_inbound_ignored') {
      // Lost the race against a concurrent run-start between the
      // pre-check above and the INSERT.
      return NextResponse.json(
        {
          error:
            'This contact already has an active flow run in progress. End it before starting a new one.',
        },
        { status: 409 },
      )
    }

    return NextResponse.json({
      flow_run_id: result.flow_run_id,
      outcome: result.outcome,
    })
  } catch (err) {
    console.error('[flows] manual run error:', err)
    return NextResponse.json(
      { error: 'Failed to start the flow for this contact.' },
      { status: 500 },
    )
  }
}
