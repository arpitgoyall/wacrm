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
    let conv = byContact.get(contact.id)
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
// ------------------------------------------------------------
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
  const earliestQuiet = new Date(now.getTime() - p.followupFirstDelayHours * HOUR)
  const oldest = new Date(
    Math.max(
      new Date(p.followupEnabledAt!).getTime(),
      now.getTime() - FOLLOWUP_LOOKBACK_MS,
    ),
  )

  const { data: convs, error } = await db
    .from('conversations')
    .select('id, contact_id, last_message_at, ai_followup_count')
    .eq('account_id', accountId)
    .neq('status', 'closed')
    .is('assigned_agent_id', null)
    .eq('ai_autoreply_disabled', false)
    .eq('ai_followup_disabled', false)
    .eq('last_message_sender_type', 'bot')
    // Only chats the AI itself is part of — either it already auto-replied
    // here or it sent the lead opener. Flows / automations / broadcasts also
    // send as 'bot', and those must not get AI nudges layered on top.
    .or('ai_reply_count.gt.0,ai_outreach_sent_at.not.is.null')
    .lt('ai_followup_count', p.followupMaxAttempts)
    .gte('last_message_at', oldest.toISOString())
    .lte('last_message_at', earliestQuiet.toISOString())
    .order('last_message_at', { ascending: true })
    .limit(budget * 4)
  if (error || !convs?.length) return res

  for (const conv of convs) {
    if (res.sent >= budget) break
    const count = (conv.ai_followup_count as number) ?? 0
    const lastAt = conv.last_message_at as string
    const quietHours = (now.getTime() - new Date(lastAt).getTime()) / HOUR
    const needed = count === 0 ? p.followupFirstDelayHours : p.followupIntervalHours
    if (quietHours < needed) continue

    try {
      const { data: lastCustomer } = await db
        .from('messages')
        .select('content_text, created_at')
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (isOptOutText(lastCustomer?.content_text)) {
        await db
          .from('conversations')
          .update({ ai_followup_disabled: true })
          .eq('id', conv.id)
        continue
      }

      const windowOpen =
        !!lastCustomer &&
        now.getTime() - new Date(lastCustomer.created_at as string).getTime() < WINDOW_MS

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

      if (windowOpen) {
        const messages = await buildConversationContext(db, conv.id)
        if (messages.length === 0) continue
        const knowledge = await retrieveKnowledge(
          db, accountId, config, latestUserMessage(messages),
        )
        const { text, handoff, usage } = await generateReply({
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
          }),
          messages: [
            ...messages,
            { role: 'user', content: '(No reply from the customer yet. Write the follow-up now.)' },
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
        if (handoff || !text) {
          await db
            .from('conversations')
            .update({ ai_followup_disabled: true })
            .eq('id', conv.id)
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
        res.sent += 1
      } else if (p.followupTemplateName) {
        if (!(await claim())) continue
        const { data: contact } = await db
          .from('contacts')
          .select('name')
          .eq('id', conv.contact_id)
          .maybeSingle()
        const params = await templateParams(
          db, accountId, p.followupTemplateName, p.templateLanguage, contact?.name ?? null,
        )
        await engineSendTemplate({
          accountId,
          userId: ownerUserId,
          conversationId: conv.id,
          contactId: conv.contact_id,
          templateName: p.followupTemplateName,
          language: p.templateLanguage,
          params,
        })
        res.sent += 1
      }
      // Window closed and no template configured: nothing legal to send.
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
