import type { SupabaseClient } from '@supabase/supabase-js'
import {
  LEAD_CARD_KEYS,
  type AiConfig,
  type AiLeadSettings,
  type LeadCard,
  type LeadOutcome,
} from './types'
import { fireConversationAssigned, pickHandoffAgent } from './handoff-assign'

// ============================================================
// Acting on the AI's lead outcome: lead card, pipeline stage, ownership.
//
// Stage moves are deliberately conservative — the AI only moves a lead
// *forward* towards Qualified, and never touches a deal a human has
// already taken to Qualified or beyond (Payment Pending, Enrolled, …)
// when marking Lost / Not Responding. Every write is best-effort: a
// failure here must never block the customer reply that preceded it.
// ============================================================

export type StageTarget = 'qualified' | 'lost' | 'not_responding' | 'follow_up'

export interface LeadContact {
  card: LeadCard
  name: string | null
  phone: string | null
}

export async function loadLeadContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<LeadContact> {
  const { data } = await db
    .from('contacts')
    .select('ai_lead_card, name, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  const raw = (data?.ai_lead_card ?? {}) as Record<string, unknown>
  const card: LeadCard = {}
  for (const key of LEAD_CARD_KEYS) {
    if (typeof raw[key] === 'string' && (raw[key] as string).trim()) {
      card[key] = (raw[key] as string).trim()
    }
  }
  return { card, name: data?.name ?? null, phone: data?.phone ?? null }
}

/** Overlay newly learned facts onto the card. Empty values never erase. */
export function mergeLeadCard(
  existing: LeadCard,
  incoming: LeadCard | null | undefined,
): { card: LeadCard; changed: boolean } {
  const card: LeadCard = { ...existing }
  let changed = false
  for (const key of LEAD_CARD_KEYS) {
    const v = incoming?.[key]?.trim()
    if (v && v !== card[key]) {
      card[key] = v
      changed = true
    }
  }
  return { card, changed }
}

export function formatLeadCard(card: LeadCard): string {
  const labels: Record<keyof LeadCard, string> = {
    name: 'Name',
    occupation: 'Does',
    goal: 'Goal',
    experience: 'Experience',
    intent: 'Intent',
    objection: 'Objection',
    city: 'City',
  }
  return LEAD_CARD_KEYS.filter((k) => card[k])
    .map((k) => `${labels[k]}: ${card[k]}`)
    .join(' · ')
}

function stageIdFor(lead: AiLeadSettings, target: StageTarget): string | null {
  switch (target) {
    case 'qualified':
      return lead.stageQualifiedId
    case 'lost':
      return lead.stageLostId
    case 'not_responding':
      return lead.stageNotRespondingId
    case 'follow_up':
      return lead.stageFollowUpId
  }
}

/**
 * Move (or, for qualified / follow_up, create) the contact's open deal in
 * the configured pipeline. Returns a short description for logs, or null
 * when nothing was done.
 */
export async function moveLeadStage(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    ownerUserId: string
    lead: AiLeadSettings | undefined
    target: StageTarget
    contactLabel: string
  },
): Promise<string | null> {
  const { lead, target } = args
  if (!lead?.pipelineId) return null
  const targetStageId = stageIdFor(lead, target)
  if (!targetStageId) return null

  try {
    const { data: stages } = await db
      .from('pipeline_stages')
      .select('id, position')
      .eq('pipeline_id', lead.pipelineId)
    const pos = new Map(
      ((stages ?? []) as { id: string; position: number }[]).map((s) => [
        s.id,
        s.position,
      ]),
    )
    const targetPos = pos.get(targetStageId)
    if (targetPos === undefined) return null // stage no longer in pipeline
    const qualifiedPos = lead.stageQualifiedId
      ? pos.get(lead.stageQualifiedId)
      : undefined

    const { data: deals } = await db
      .from('deals')
      .select('id, stage_id')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('pipeline_id', lead.pipelineId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
    const deal = deals?.[0] as { id: string; stage_id: string } | undefined

    if (!deal) {
      if (target !== 'qualified' && target !== 'follow_up') return null
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.accountId)
        .maybeSingle()
      const { error } = await db.from('deals').insert({
        account_id: args.accountId,
        user_id: args.ownerUserId,
        pipeline_id: lead.pipelineId,
        stage_id: targetStageId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        title: args.contactLabel,
        value: 0,
        currency: acct?.default_currency ?? 'INR',
        status: 'open',
      })
      if (error) {
        console.warn(`[ai lead] deal create (${target}) failed:`, error.message)
        return null
      }
      return `deal created at ${target}`
    }

    if (deal.stage_id === targetStageId) return null
    const currentPos = pos.get(deal.stage_id) ?? -1
    const forwardOnly = target === 'qualified' || target === 'follow_up'
    if (forwardOnly && currentPos >= targetPos) return null
    if (!forwardOnly) {
      // Never pull a qualified-or-later deal back to Lost / Not Responding,
      // and never overwrite a deal that is already Lost.
      if (qualifiedPos !== undefined && currentPos >= qualifiedPos) return null
      if (lead.stageLostId && deal.stage_id === lead.stageLostId) return null
    }

    const { error } = await db
      .from('deals')
      .update({ stage_id: targetStageId })
      .eq('id', deal.id)
    if (error) {
      // e.g. the target stage has required custom fields the AI can't fill.
      console.warn(`[ai lead] deal move (${target}) failed:`, error.message)
      return null
    }
    return `deal moved to ${target}`
  } catch (err) {
    console.warn(`[ai lead] stage move (${target}) threw:`, err)
    return null
  }
}

async function addLeadNote(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; ownerUserId: string; text: string },
): Promise<void> {
  const { error } = await db.from('contact_notes').insert({
    account_id: args.accountId,
    contact_id: args.contactId,
    user_id: args.ownerUserId,
    note_text: args.text,
  })
  if (error) console.warn('[ai lead] note insert failed:', error.message)
}

/**
 * Persist the lead card and act on the outcome. `needs_human` only saves
 * the card (the caller runs the handoff itself).
 */
export async function applyLeadOutcome(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    ownerUserId: string
    config: AiConfig
    outcome: LeadOutcome | null | undefined
    incoming: LeadCard | null | undefined
    contact: LeadContact
    /** conversations.ai_outcome before this turn. */
    currentOutcome: string | null
    /** conversations.assigned_agent_id before this turn. */
    assignedAgentId: string | null
  },
): Promise<void> {
  try {
    const { accountId, conversationId, contactId, ownerUserId, config } = args
    const { card, changed } = mergeLeadCard(args.contact.card, args.incoming)
    if (changed) {
      const { error } = await db
        .from('contacts')
        .update({ ai_lead_card: card })
        .eq('id', contactId)
        .eq('account_id', accountId)
      if (error) console.warn('[ai lead] card save failed:', error.message)
    }

    const contactLabel =
      card.name || args.contact.name || args.contact.phone || 'WhatsApp lead'
    const stageArgs = {
      accountId,
      contactId,
      conversationId,
      ownerUserId,
      lead: config.lead,
      contactLabel,
    }
    const now = new Date().toISOString()
    const cardText = formatLeadCard(card)

    if (args.outcome === 'qualified' && args.currentOutcome !== 'qualified') {
      await moveLeadStage(db, { ...stageArgs, target: 'qualified' })

      // Hand the qualified lead to a counsellor; the AI's job ends here.
      const update: Record<string, unknown> = {
        ai_outcome: 'qualified',
        ai_outcome_at: now,
        ai_autoreply_disabled: true,
        ai_handoff_summary: `AI qualified this lead. ${cardText}`.trim(),
      }
      let assignee: string | null = null
      if (!args.assignedAgentId) {
        assignee = config.handoffAgentId ?? (await pickHandoffAgent(db, accountId))
        if (assignee) update.assigned_agent_id = assignee
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      await addLeadNote(db, {
        accountId,
        contactId,
        ownerUserId,
        text: `🤖 AI qualified this lead. ${cardText}`,
      })
      if (assignee) {
        await fireConversationAssigned(db, {
          accountId,
          conversationId,
          contactId,
          agentId: assignee,
        })
      }
      return
    }

    if (args.outcome === 'lost' && args.currentOutcome !== 'lost') {
      await moveLeadStage(db, { ...stageArgs, target: 'lost' })
      await db
        .from('conversations')
        .update({ ai_outcome: 'lost', ai_outcome_at: now })
        .eq('id', conversationId)
      await addLeadNote(db, {
        accountId,
        contactId,
        ownerUserId,
        text: `🤖 AI marked this lead as lost (customer declined). ${cardText}`.trim(),
      })
      return
    }

    if (args.outcome === 'continue') {
      // A lead we had written off is talking again — let follow-ups resume.
      if (args.currentOutcome === 'lost' || args.currentOutcome === 'not_responding') {
        await db
          .from('conversations')
          .update({ ai_outcome: null, ai_outcome_at: null })
          .eq('id', conversationId)
      }
      // A new objection (price, timing, …) → Follow Up stage.
      if (args.incoming?.objection && args.incoming.objection !== args.contact.card.objection) {
        await moveLeadStage(db, { ...stageArgs, target: 'follow_up' })
      }
    }
  } catch (err) {
    console.error('[ai lead] applyLeadOutcome failed:', err)
  }
}
