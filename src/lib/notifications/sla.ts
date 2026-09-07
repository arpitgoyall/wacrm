import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * SLA-breach sweep for assigned conversations sitting on an unanswered
 * customer message. Run from `/api/automations/cron`.
 *
 * A conversation breaches when, for its account's
 * `sla_response_minutes` threshold:
 *   - it isn't closed and has an assignee,
 *   - its most recent message is from the customer,
 *   - that message is older than the threshold,
 *   - we haven't already raised a breach for this same unanswered run
 *     (`sla_notified_at` predates the customer message — an agent
 *     reply or a fresh inbound naturally re-arms it).
 */

interface BreachInput {
  latestSenderType: 'customer' | 'agent' | 'bot' | null
  latestMessageAt: string | null
  slaMinutes: number
  slaNotifiedAt: string | null
  now: Date
}

/** Pure predicate — unit-tested without a DB. */
export function isSlaBreach(input: BreachInput): boolean {
  const { latestSenderType, latestMessageAt, slaMinutes, slaNotifiedAt, now } =
    input
  if (slaMinutes <= 0) return false
  if (latestSenderType !== 'customer' || !latestMessageAt) return false

  const msgTime = new Date(latestMessageAt).getTime()
  if (Number.isNaN(msgTime)) return false

  const ageMinutes = (now.getTime() - msgTime) / 60_000
  if (ageMinutes < slaMinutes) return false

  // Already notified for this unanswered run? (marker set at/after the
  // customer message)
  if (slaNotifiedAt && new Date(slaNotifiedAt).getTime() >= msgTime) {
    return false
  }
  return true
}

const MAX_ACCOUNTS = 200
const MAX_CONVERSATIONS_PER_ACCOUNT = 200

export async function sweepSlaBreaches(): Promise<{ notified: number }> {
  const db = supabaseAdmin()
  const now = new Date()

  const { data: accounts, error: acctErr } = await db
    .from('accounts')
    .select('id, sla_response_minutes')
    .gt('sla_response_minutes', 0)
    .limit(MAX_ACCOUNTS)
  if (acctErr || !accounts || accounts.length === 0) {
    return { notified: 0 }
  }

  let notified = 0

  for (const acct of accounts) {
    const slaMinutes = Number(acct.sla_response_minutes) || 0
    if (slaMinutes <= 0) continue

    // Only conversations old enough to possibly breach.
    const cutoff = new Date(now.getTime() - slaMinutes * 60_000).toISOString()
    const { data: convs, error: convErr } = await db
      .from('conversations')
      .select('id, account_id, contact_id, assigned_agent_id, sla_notified_at')
      .eq('account_id', acct.id)
      .neq('status', 'closed')
      .not('assigned_agent_id', 'is', null)
      .lte('last_message_at', cutoff)
      .limit(MAX_CONVERSATIONS_PER_ACCOUNT)
    if (convErr || !convs || convs.length === 0) continue

    for (const c of convs) {
      const { data: lastMsg } = await db
        .from('messages')
        .select('sender_type, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const breach = isSlaBreach({
        latestSenderType:
          (lastMsg?.sender_type as BreachInput['latestSenderType']) ?? null,
        latestMessageAt: (lastMsg?.created_at as string | null) ?? null,
        slaMinutes,
        slaNotifiedAt: (c.sla_notified_at as string | null) ?? null,
        now,
      })
      if (!breach) continue

      // Claim the breach: only proceed if the marker is still what we
      // read, so two overlapping sweeps don't double-notify.
      const stamp = now.toISOString()
      const claim = db
        .from('conversations')
        .update({ sla_notified_at: stamp })
        .eq('id', c.id)
      const { data: claimed, error: claimErr } = c.sla_notified_at
        ? await claim.eq('sla_notified_at', c.sla_notified_at).select('id')
        : await claim.is('sla_notified_at', null).select('id')
      if (claimErr || !claimed || claimed.length === 0) continue

      const { error: insErr } = await db.from('notifications').insert({
        account_id: c.account_id,
        user_id: c.assigned_agent_id,
        type: 'sla_breach',
        conversation_id: c.id,
        contact_id: c.contact_id,
        actor_user_id: null,
        title: 'Reply overdue',
        body: `A customer has been waiting more than ${slaMinutes} min for a reply.`,
      })
      if (!insErr) notified += 1
    }
  }

  return { notified }
}
