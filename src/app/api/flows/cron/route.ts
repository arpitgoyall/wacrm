import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { checkCronAuth } from '@/lib/cron-auth'
import { engineSendText } from '@/lib/flows/meta-send'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  // Accepts Vercel Cron's `Authorization: Bearer $CRON_SECRET` or an
  // external pinger's `x-cron-secret: $AUTOMATION_CRON_SECRET`.
  const auth = checkCronAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? 'cron not configured' : 'Unauthorized' },
      { status: auth.status },
    )
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, account_id, user_id, contact_id, conversation_id, current_node_key, follow_up_attempts, last_advanced_at, flows ( fallback_policy )',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!runs?.length) return NextResponse.json({ swept: 0 })

  type Row = {
    id: string
    flow_id: string
    user_id: string
    account_id: string
    contact_id: string | null
    conversation_id: string | null
    current_node_key: string | null
    follow_up_attempts: number
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
  }

  let swept = 0
  let followedUp = 0
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) {
      const cfg = policy.follow_up
      if (!cfg || !r.contact_id || !r.conversation_id || !r.current_node_key ||
          r.follow_up_attempts >= cfg.max_attempts) continue
      const dueHours = cfg.first_delay_hours + r.follow_up_attempts * cfg.interval_hours
      if (ageHours < dueHours) continue

      // A reply to this prompt cancels all remaining reminders, including
      // replies that did not match an option and left the run at this node.
      const { data: reply, error: replyError } = await admin.from('flow_run_events')
        .select('id').eq('flow_run_id', r.id).eq('event_type', 'reply_received')
        .gt('created_at', r.last_advanced_at).limit(1)
      if (replyError || reply?.length) continue

      // Free-form text can only be sent while the customer's latest
      // inbound message still opens a service conversation.
      const { data: inbound, error: inboundError } = await admin.from('messages')
        .select('created_at').eq('conversation_id', r.conversation_id)
        .eq('sender_type', 'customer').order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      if (inboundError || !inbound || now.getTime() - new Date(inbound.created_at).getTime() >= 24 * 60 * 60 * 1000) continue

      // Claim before the external send. A concurrent cron must not send
      // the same reminder twice. Node/time/status guards reject a reply
      // that advanced the run while this scan was in progress.
      const { data: claimed } = await admin.from('flow_runs')
        .update({ follow_up_attempts: r.follow_up_attempts + 1 })
        .eq('id', r.id).eq('status', 'active')
        .eq('current_node_key', r.current_node_key)
        .eq('last_advanced_at', r.last_advanced_at)
        .eq('follow_up_attempts', r.follow_up_attempts).select('id')
      if (!claimed?.length) continue
      const { data: lateReply, error: lateReplyError } = await admin.from('flow_run_events')
        .select('id').eq('flow_run_id', r.id).eq('event_type', 'reply_received')
        .gt('created_at', r.last_advanced_at).limit(1)
      if (lateReplyError || lateReply?.length) continue
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: r.account_id, userId: r.user_id,
          contactId: r.contact_id, conversationId: r.conversation_id,
          text: cfg.message,
        })
        await admin.from('flow_run_events').insert({
          flow_run_id: r.id, event_type: 'message_sent', node_key: r.current_node_key,
          payload: { node_type: 'follow_up', attempt: r.follow_up_attempts + 1, whatsapp_message_id },
        })
        followedUp += 1
      } catch (err) {
        await admin.from('flow_run_events').insert({
          flow_run_id: r.id, event_type: 'error', node_key: r.current_node_key,
          payload: { reason: 'follow_up_failed', attempt: r.follow_up_attempts + 1,
            detail: err instanceof Error ? err.message : String(err) },
        })
      }
      continue
    }

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept, followed_up: followedUp })
}
