import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import type { AiConfig, AiProactiveSettings } from './types'
import { engineSendText } from '@/lib/flows/meta-send'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { applyLeadOutcome, loadLeadContact, moveLeadStage } from './lead-outcome'

// ============================================================
// Proactive AI agent: new-lead outreach + re-engagement.
//
// Driven by pg_cron → /api/ai/proactive/cron every few minutes. Every
// send is claimed with a guarded UPDATE *before* it goes out, so two
// overlapping ticks can never message the same lead twice (we prefer to
// skip an attempt over double-texting).
//
// WhatsApp rule: free-form text is only allowed within 24h of the
// customer's last message. Outside that window (and for brand-new leads
// who never wrote) only an approved template may be sent.
// ============================================================

const HOUR = 60 * 60 * 1000
/** Stay safely inside Meta's 24h window. */
const WINDOW_MS = 23.5 * HOUR
/** Max sends per account per tick — a throttle on top of the daily cap. */
const PER_RUN_LIMIT = 15
const NEW_LEAD_LOOKBACK_MS = 3 * 24 * HOUR
const FOLLOWUP_LOOKBACK_MS = 14 * 24 * HOUR

const OPT_OUT_RE =
  /\b(stop|unsubscribe|not interested|no thanks|don'?t (message|text|contact|call)|do not (message|text|contact|call)|remove me|leave me alone|mat bhejo|mat karo|message mat|band karo|nahi chahiye|nhi chahiye)\b/i

export function isOptOutText(text: string | null | undefined): boolean {
  return !!text && OPT_OUT_RE.test(text)
}

export interface ProactiveSummary {
  accounts: number
  outreachSent: number
  followupsSent: number
  errors: number
}

export async function runAiProactive(
  now: Date = new Date(),
): Promise<ProactiveSummary> {
  const db = supabaseAdmin()
  const summary: ProactiveSummary = {
    accounts: 0,
    outreachSent: 0,
    followupsSent: 0,
    errors: 0,
  }

  const { data: rows, error } = await db
    .from('ai_configs')
    .select('account_id')
    .eq('is_active', true)
    .or('outreach_enabled.eq.true,followup_enabled.eq.true')
  if (error) {
    console.error('[ai proactive] account scan failed:', error.message)
    summary.errors += 1
    return summary
  }

  for (const row of rows ?? []) {
    const accountId = row.account_id as string
    try {
      const config = await loadAiConfig(db, accountId)
      if (!config?.proactive) continue
      summary.accounts += 1
      const r = await runForAccount(db, accountId, config, config.proactive, now)
      summary.outreachSent += r.outreach
      summary.followupsSent += r.followups
      summary.errors += r.errors
    } catch (err) {
      summary.errors += 1
      console.error(`[ai proactive] account ${accountId} failed:`, err)
    }
  }
  return summary
}

async function runForAccount(
  db: SupabaseClient,
  accountId: string,
  config: AiConfig,
  p: AiProactiveSettings,
  now: Date,
): Promise<{ outreach: number; followups: number; errors: number }> {
  const out = { outreach: 0, followups: 0, errors: 0 }

  // The owner id is only used for audit columns on the outbound rows.
  const { data: wa } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!wa?.user_id) return out
  const ownerUserId = wa.user_id as string

  // Daily cap across both features (approximate for follow-ups).
  const dayAgo = new Date(now.getTime() - 24 * HOUR).toISOString()
  const [{ count: openedToday }, { count: nudgedToday }] = await Promise.all([
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('ai_outreach_sent_at', dayAgo),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gt('ai_followup_count', 0)
      .eq('last_message_sender_type', 'bot')
      .gte('last_message_at', dayAgo),
  ])
  let budget = Math.min(
    PER_RUN_LIMIT,
    p.dailyCap - (openedToday ?? 0) - (nudgedToday ?? 0),
  )
  if (budget <= 0) return out

  if (p.outreachEnabled && p.outreachTemplateName && p.outreachEnabledAt) {
    const r = await runOutreach(db, accountId, ownerUserId, p, now, budget)
    out.outreach = r.sent
    out.errors += r.errors
    budget -= r.sent
  }

  if (budget > 0 && p.followupEnabled && p.followupEnabledAt) {
    const r = await runFollowups(db, accountId, ownerUserId, config, p, now, budget)
    out.followups = r.sent
    out.errors += r.errors
  }
  return out
}

/** `{{1}}` support: pass the lead's first name when the template wants one. */
async function templateParams(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  language: string,
  contactName: string | null,
): Promise<string[]> {
  const { row } = await resolveTemplateRow(db, accountId, templateName, language)
  if (!row?.body_text || !/\{\{1\}\}/.test(row.body_text)) return []
  const first = (contactName ?? '').trim().split(/\s+/)[0]
  return [first || 'there']
}

// ------------------------------------------------------------
// New-lead outreach
// ------------------------------------------------------------
async function runOutreach(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  p: AiProactiveSettings,
  now: Date,
  budget: number,
): Promise<{ sent: number; errors: number }> {
  const res = { sent: 0, errors: 0 }
  const templateName = p.outreachTemplateName!
  const newest = new Date(now.getTime() - p.outreachDelayMinutes * 60_000)
  const oldest = new Date(
    Math.max(
      new Date(p.outreachEnabledAt!).getTime(),
      now.getTime() - NEW_LEAD_LOOKBACK_MS,
    ),
  )

  const { data: contacts, error } = await db
    .from('contacts')
    .select('id, name, created_at')
    .eq('account_id', accountId)
    .gte('created_at', oldest.toISOString())
    .lte('created_at', newest.toISOString())
    .order('created_at', { ascending: true })
    .limit(budget * 3)
  if (error || !contacts?.length) return res

  const { data: convs } = await db
    .from('conversations')
    .select('id, contact_id, last_message_at, ai_outreach_sent_at, ai_followup_disabled')
    .eq('account_id', accountId)
    .in('contact_id', contacts.map((c) => c.id))
  const byContact = new Map((convs ?? []).map((c) => [c.contact_id as string, c]))

  for (const contact of contacts) {
    if (res.sent >= budget) break
    const conv = byContact.get(contact.id)
    // Anyone who already has a message history (they wrote first, or a
    // human reached out) is not a cold lead.
    if (conv && (conv.ai_outreach_sent_at || conv.last_message_at || conv.ai_followup_disabled)) {
      continue
    }
    try {
      let conversationId = conv?.id as string | undefined
      if (!conversationId) {
        const { data: created, error: insErr } = await db
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            contact_id: contact.id,
          })
          .select('id')
          .single()
        if (insErr || !created) {
          res.errors += 1
          continue
        }
        conversationId = created.id as string
      }

      const { data: claimed } = await db
        .from('conversations')
        .update({ ai_outreach_sent_at: now.toISOString() })
        .eq('id', conversationId)
        .is('ai_outreach_sent_at', null)
        .select('id')
      if (!claimed?.length) continue

      const params = await templateParams(
        db, accountId, templateName, p.templateLanguage, contact.name,
      )
      await engineSendTemplate({
        accountId,
        userId: ownerUserId,
        conversationId,
        contactId: contact.id,
        templateName,
        language: p.templateLanguage,
        params,
      })
      res.sent += 1
    } catch (err) {
      res.errors += 1
      console.error(
        `[ai proactive] outreach to contact ${contact.id} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return res
}

// ------------------------------------------------------------
// Re-engagement of quiet conversations
//
// Rules (phase 1):
//   - Promotional nudges only inside WhatsApp's 24h free-form window — no
//     templates. The window is measured from the customer's last message.
//   - Runs whether or not a human was assigned / the AI handed off. It
//     skips chats where the customer is waiting on us (last sender is the
//     customer), where a human spoke very recently, and leads that are
//     already qualified (by the AI or a human moving the deal) or lost.
//   - Only during the account's send hours (quiet hours, local time).
//   - The model decides per chat whether a nudge would actually help
//     ([[SKIP]]); a skipped chat still uses up that attempt so it isn't
//     re-asked every tick.
// ------------------------------------------------------------

/** Hour (0-23) in the given IANA time zone. */
export function localHour(now: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now)
    return Number(h) % 24
  } catch {
    return now.getUTCHours()
  }
}

export function withinSendHours(
  now: Date,
  p: Pick<AiProactiveSettings, 'sendStartHour' | 'sendEndHour' | 'timezone'>,
): boolean {
  const h = localHour(now, p.timezone)
  return p.sendStartHour <= p.sendEndHour
    ? h >= p.sendStartHour && h < p.sendEndHour
    : h >= p.sendStartHour || h < p.sendEndHour // window crosses midnight
}

/** A human teammate's message must be at least this old before we nudge. */
const HUMAN_ACTIVE_MS = 2 * HOUR

async function runFollowups(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  config: AiConfig,
  p: AiProactiveSettings,
  now: Date,
  budget: number,
): Promise<{ sent: number; errors: number }> {
  const res = { sent: 0, errors: 0 }

  // Leads whose window closed after our nudges, unanswered → Not Responding.
  await markNotResponding(db, accountId, ownerUserId, config, p, now)

  if (!withinSendHours(now, p)) return res

  const earliestQuiet = new Date(now.getTime() - p.followupFirstDelayHours * HOUR)
  const windowStart = new Date(now.getTime() - WINDOW_MS)
  const oldest = new Date(
    Math.max(
      new Date(p.followupEnabledAt!).getTime(),
      now.getTime() - FOLLOWUP_LOOKBACK_MS,
    ),
  )

  const { data: convs, error } = await db
    .from('conversations')
    .select('id, contact_id, last_message_at, last_message_sender_type, ai_followup_count')
    .eq('account_id', accountId)
    .neq('status', 'closed')
    .eq('ai_followup_disabled', false)
    .is('ai_outcome', null)
    .in('last_message_sender_type', ['bot', 'agent'])
    .lt('ai_followup_count', p.followupMaxAttempts)
    .gte('last_customer_message_at', windowStart.toISOString())
    .gte('last_message_at', oldest.toISOString())
    .lte('last_message_at', earliestQuiet.toISOString())
    .order('last_message_at', { ascending: true })
    .limit(budget * 4)
  if (error || !convs?.length) return res

  const guard = await loadQualifiedGuard(db, config)

  for (const conv of convs) {
    if (res.sent >= budget) break
    const count = (conv.ai_followup_count as number) ?? 0
    const lastAt = conv.last_message_at as string
    const quietMs = now.getTime() - new Date(lastAt).getTime()
    const quietHours = quietMs / HOUR
    const needed = count === 0 ? p.followupFirstDelayHours : p.followupIntervalHours
    if (quietHours < needed) continue
    if (conv.last_message_sender_type === 'agent' && quietMs < HUMAN_ACTIVE_MS) continue

    try {
      // A human may have moved the deal to Qualified or beyond — stop there.
      if (await dealAtOrPastQualified(db, accountId, conv.contact_id, guard)) continue

      const { data: lastCustomer } = await db
        .from('messages')
        .select('content_text, created_at')
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!lastCustomer) continue
      if (now.getTime() - new Date(lastCustomer.created_at as string).getTime() >= WINDOW_MS) {
        continue // the window closed since the query
      }

      if (isOptOutText(lastCustomer.content_text)) {
        await db
          .from('conversations')
          .update({ ai_followup_disabled: true })
          .eq('id', conv.id)
        continue
      }

      const claim = async (): Promise<boolean> => {
        const { data } = await db
          .from('conversations')
          .update({ ai_followup_count: count + 1 })
          .eq('id', conv.id)
          .eq('ai_followup_count', count)
          .eq('last_message_at', lastAt)
          .select('id')
        return !!data?.length
      }

      const messages = await buildConversationContext(db, conv.id)
      if (messages.length === 0) continue
      const leadContact = await loadLeadContact(db, accountId, conv.contact_id)
      const knowledge = await retrieveKnowledge(
        db, accountId, config, latestUserMessage(messages),
      )
      const { text, handoff, usage, outcome, lead, skip } = await generateReply({
        config,
        systemPrompt: buildSystemPrompt({
          userPrompt: config.systemPrompt,
          mode: 'auto_reply',
          knowledge,
          followup: {
            attempt: count + 1,
            maxAttempts: p.followupMaxAttempts,
            hoursSilent: quietHours,
          },
          leadTracking: { criteria: config.lead?.criteria ?? null, card: leadContact.card },
        }),
        messages: [
          ...messages,
          { role: 'user', content: '(No reply from the customer yet. Decide whether to send a follow-up now.)' },
        ],
      })
      void logAiUsage(db, {
        accountId,
        conversationId: conv.id,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage,
      })

      const outcomeArgs = {
        accountId,
        conversationId: conv.id,
        contactId: conv.contact_id as string,
        ownerUserId,
        config,
        contact: leadContact,
        currentOutcome: null,
        assignedAgentId: null,
        incoming: lead,
      }

      if (outcome === 'lost') {
        await applyLeadOutcome(db, { ...outcomeArgs, outcome: 'lost' })
        continue
      }
      if (handoff) {
        // A human is better placed; stop nudging this chat.
        await db.from('conversations').update({ ai_followup_disabled: true }).eq('id', conv.id)
        await applyLeadOutcome(db, { ...outcomeArgs, outcome: 'needs_human' }) // card only
        continue
      }
      if (skip || !text) {
        await claim() // use up this attempt without sending
        await applyLeadOutcome(db, { ...outcomeArgs, outcome: 'needs_human' }) // card only
        continue
      }
      if (!(await claim())) continue
      await engineSendText({
        accountId,
        userId: ownerUserId,
        conversationId: conv.id,
        contactId: conv.contact_id,
        text,
        aiGenerated: true,
      })
      // Save the card only — a nudge the customer hasn't answered never qualifies.
      await applyLeadOutcome(db, { ...outcomeArgs, outcome: 'needs_human' })
      res.sent += 1
    } catch (err) {
      res.errors += 1
      console.error(
        `[ai proactive] follow-up on conversation ${conv.id} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return res
}

interface QualifiedGuard {
  pipelineId: string
  positions: Map<string, number>
  qualifiedPos: number
}

async function loadQualifiedGuard(
  db: SupabaseClient,
  config: AiConfig,
): Promise<QualifiedGuard | null> {
  const lead = config.lead
  if (!lead?.pipelineId || !lead.stageQualifiedId) return null
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, position')
    .eq('pipeline_id', lead.pipelineId)
  const positions = new Map(
    ((stages ?? []) as { id: string; position: number }[]).map((s) => [s.id, s.position]),
  )
  const qualifiedPos = positions.get(lead.stageQualifiedId)
  if (qualifiedPos === undefined) return null
  return { pipelineId: lead.pipelineId, positions, qualifiedPos }
}

async function dealAtOrPastQualified(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  guard: QualifiedGuard | null,
): Promise<boolean> {
  if (!guard) return false
  const { data: deals } = await db
    .from('deals')
    .select('stage_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('pipeline_id', guard.pipelineId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const stageId = (deals?.[0] as { stage_id: string } | undefined)?.stage_id
  if (!stageId) return false
  return (guard.positions.get(stageId) ?? -1) >= guard.qualifiedPos
}

/** Nudged at least once, still unanswered, and the 24h window has closed. */
async function markNotResponding(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  config: AiConfig,
  p: AiProactiveSettings,
  now: Date,
): Promise<void> {
  try {
    const windowStart = new Date(now.getTime() - WINDOW_MS)
    const oldest = new Date(
      Math.max(new Date(p.followupEnabledAt!).getTime(), now.getTime() - FOLLOWUP_LOOKBACK_MS),
    )
    const { data: convs } = await db
      .from('conversations')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .is('ai_outcome', null)
      .gt('ai_followup_count', 0)
      .in('last_message_sender_type', ['bot', 'agent'])
      .lt('last_customer_message_at', windowStart.toISOString())
      .gte('last_message_at', oldest.toISOString())
      .limit(25)
    for (const conv of convs ?? []) {
      const { data: claimed } = await db
        .from('conversations')
        .update({ ai_outcome: 'not_responding', ai_outcome_at: now.toISOString() })
        .eq('id', conv.id)
        .is('ai_outcome', null)
        .select('id')
      if (!claimed?.length) continue
      const contact = await loadLeadContact(db, accountId, conv.contact_id)
      await moveLeadStage(db, {
        accountId,
        contactId: conv.contact_id,
        conversationId: conv.id,
        ownerUserId,
        lead: config.lead,
        target: 'not_responding',
        contactLabel: contact.card.name || contact.name || contact.phone || 'WhatsApp lead',
      })
    }
  } catch (err) {
    console.error('[ai proactive] not-responding sweep failed:', err)
  }
}
