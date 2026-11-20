import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import type { AiConfig, ChatMessage } from './types'
import { fireConversationAssigned, pickHandoffAgent } from './handoff-assign'
import { applyLeadOutcome, loadLeadContact } from './lead-outcome'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * What the AI can do with an inbound message:
 *   - `text`       — readable text (typed text, a caption, a button tap)
 *   - `unreadable` — content the AI can't understand (voice note, photo or
 *                    video without caption, document, location): a human
 *                    must look, so the chat is handed off
 *   - `ignore`     — nothing to answer (sticker, reaction, empty)
 */
export type InboundKind = 'text' | 'unreadable' | 'ignore'

export function classifyInbound(type: string, text: string): InboundKind {
  const hasText = text.trim().length > 0
  switch (type) {
    case 'text':
    case 'interactive': // list / reply-button tap
    case 'button': // template quick-reply tap
      return hasText ? 'text' : 'ignore'
    case 'image':
    case 'video':
      return hasText ? 'text' : 'unreadable' // caption → readable
    case 'sticker':
    case 'reaction':
      return 'ignore'
    case 'audio':
    case 'document':
    case 'location':
    default:
      return 'unreadable'
  }
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta id (wamid) of the inbound message being answered. Drives the
   *  "typing…" bubble and the quick-succession debounce. */
  inboundMessageId?: string
  /** Defaults to `text`. See {@link classifyInbound}. */
  inboundKind?: InboundKind
  /** The inbound was a button / list tap. If an active `interactive_reply`
   *  automation exists it owns taps, and the AI stands down. */
  inboundIsTap?: boolean
}

/**
 * How long to wait after an inbound message before answering, so a lead
 * who sends "hi" / "I want info" / "price?" in quick succession gets ONE
 * reply covering all of it instead of three. Override with
 * `AI_REPLY_DEBOUNCE_MS` (0 disables).
 */
function replyDebounceMs(): number {
  const raw = Number(process.env.AI_REPLY_DEBOUNCE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 4000
}

/** Alert owner + admins that the AI handed a chat to a human. Reuses the
 *  `new_conversation` notification type, which the inbox clears once the
 *  conversation is opened and which already drives web push. */
async function notifyHandoffToTeam(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  conversationId: string,
  contactId: string,
  messages: ChatMessage[],
): Promise<void> {
  try {
    const { data: recipients } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
    if (!recipients?.length) return

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const who = contact?.name?.trim() || contact?.phone || 'A customer'
    const last = latestUserMessage(messages)

    const { error } = await db.from('notifications').insert(
      (recipients as { user_id: string }[]).map((r) => ({
        account_id: accountId,
        user_id: r.user_id,
        type: 'new_conversation' as const,
        conversation_id: conversationId,
        contact_id: contactId,
        actor_user_id: null,
        title: 'AI needs a human',
        body: last
          ? `${who}: “${last.slice(0, 100)}” — the AI handed this chat to your team.`
          : `${who} needs a human — the AI handed this chat to your team.`,
      })),
    )
    if (error) console.error('[ai auto-reply] handoff notification failed:', error.message)
  } catch (err) {
    console.error('[ai auto-reply] handoff notification threw:', err)
  }
}

/**
 * Hand the conversation to a person — the one path for every reason (the
 * model asked for a human, the reply cap was hit, the customer sent a
 * voice note the AI can't hear). Pauses the AI here, assigns the
 * configured handoff agent or the least-busy agent, and fires the
 * account's `conversation_assigned` automation (which owns the customer
 * message). With nobody to assign, owner + admins are notified instead.
 */
async function handOffToHuman(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    config: AiConfig
    summary: string
    messages: ChatMessage[]
  },
): Promise<void> {
  const { accountId, conversationId, contactId, config } = args
  let assignee: string | null = config.handoffAgentId
  if (!assignee) {
    try {
      assignee = await pickHandoffAgent(db, accountId)
    } catch (err) {
      console.error('[ai auto-reply] picking a handoff agent failed:', err)
    }
  }

  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: args.summary,
  }
  if (assignee) update.assigned_agent_id = assignee

  // Guarded so two concurrent handoffs (e.g. quick messages racing) assign
  // and notify only once; never stomps an assignment a human just made.
  const { data: claimed } = await db
    .from('conversations')
    .update(update)
    .eq('id', conversationId)
    .eq('ai_autoreply_disabled', false)
    .is('assigned_agent_id', null)
    .select('id')
  if (!claimed?.length) return

  if (assignee) {
    try {
      await fireConversationAssigned(db, {
        accountId,
        conversationId,
        contactId,
        agentId: assignee,
      })
    } catch (err) {
      console.error('[ai auto-reply] conversation_assigned automation failed:', err)
    }
  } else {
    await notifyHandoffToTeam(db, accountId, conversationId, contactId, args.messages)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A believable typing pause before a follow-on message: longer messages
 *  take a little longer, bounded to 1.2–4s so a full reply stays quick. */
export function typingPauseMs(message: string): number {
  return Math.min(4000, Math.max(1200, 600 + message.length * 35))
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). It owns its
 * try/catch and NEVER throws — a failing or slow LLM call must not affect
 * the webhook's 200 to Meta.
 *
 * Silent no-ops: AI / auto-reply off, a message-level automation is active,
 * a human owns the thread, the AI was paused here, or nothing to answer.
 * Everything else ends in a reply or a handoff — a lead is never left in
 * silence (reply cap reached and unreadable media both hand off).
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  const kind = args.inboundKind ?? 'text'
  if (kind === 'ignore') return

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer.
    const responderTriggers = ['new_message_received', 'keyword_match']
    if (args.inboundIsTap) responderTriggers.push('interactive_reply')
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', responderTriggers)
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_outcome')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    const messages = await buildConversationContext(db, conversationId)
    const replyCount = (conv.ai_reply_count as number) ?? 0

    // Voice note / photo without caption / document / location: the AI
    // can't read it, so a person has to look.
    if (kind === 'unreadable') {
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        config,
        messages,
        summary: buildHandoffSummary({
          messages,
          replyCount,
          reason: 'the customer sent a voice note or file the AI can’t read',
        }),
      })
      return
    }

    // Reply cap reached → hand off rather than go silent. (Cheap early
    // check; the authoritative one is the atomic slot claim below.)
    if (replyCount >= config.autoReplyMaxPerConversation) {
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        config,
        messages,
        summary: buildHandoffSummary({
          messages,
          replyCount,
          reason: 'it reached its reply limit for this chat',
        }),
      })
      return
    }

    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Show "typing…" to the customer while we generate (and again between
    // the parts of a split reply). Best-effort, 5s cap per call.
    let showTyping: () => Promise<void> = async () => {}
    if (args.inboundMessageId) {
      const { data: wa } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', accountId)
        .maybeSingle()
      if (wa?.phone_number_id && wa.access_token) {
        try {
          const creds = {
            phoneNumberId: wa.phone_number_id as string,
            accessToken: decrypt(wa.access_token),
            messageId: args.inboundMessageId,
          }
          showTyping = () => sendTypingIndicator(creds)
        } catch (err) {
          console.warn('[ai auto-reply] typing indicator skipped:', err)
        }
      }
    }
    await showTyping()

    // Debounce quick succession: wait briefly, and if the customer has sent
    // something newer, stand down — that message's run answers everything.
    const debounce = replyDebounceMs()
    if (args.inboundMessageId && debounce > 0) {
      await sleep(debounce)
      const { data: latest } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (latest?.message_id && latest.message_id !== args.inboundMessageId) return
    }

    // Re-read the transcript after the wait so it includes every message
    // the customer sent in the burst.
    const transcript =
      args.inboundMessageId && debounce > 0
        ? await buildConversationContext(db, conversationId)
        : messages

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(transcript),
    )

    // What we already know about this lead — fed to the model so it doesn't
    // re-ask, and merged with whatever it learns this turn.
    const leadContact = await loadLeadContact(db, accountId, contactId)

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      leadTracking: { criteria: config.lead?.criteria ?? null, card: leadContact.card },
    })

    const outcomeArgs = {
      accountId,
      conversationId,
      contactId,
      ownerUserId: configOwnerUserId,
      config,
      contact: leadContact,
      currentOutcome: (conv.ai_outcome as string | null) ?? null,
      assignedAgentId: null,
    }

    const { text, handoff, usage, outcome, lead, parts } = await generateReply({
      config,
      systemPrompt,
      messages: transcript,
    })

    // Record token spend on the account's BYO key (fire-and-forget; logged
    // regardless of handoff — the provider call happened either way).
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer. Keep what it learned about
      // the lead for whoever picks it up, then hand off.
      await applyLeadOutcome(db, { ...outcomeArgs, outcome: 'needs_human', incoming: lead })
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        config,
        messages: transcript,
        summary: buildHandoffSummary({ messages: transcript, replyCount }),
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap.
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      // Lost the race for the last slot → the cap is reached; hand off.
      await handOffToHuman(db, {
        accountId,
        conversationId,
        contactId,
        config,
        messages: transcript,
        summary: buildHandoffSummary({
          messages: transcript,
          replyCount,
          reason: 'it reached its reply limit for this chat',
        }),
      })
      return
    }

    // Send like a person texting: one message, or 2–3 short ones with a
    // "typing…" pause before each later part. The whole turn counts as one
    // reply against the per-conversation cap (one slot claimed above).
    const messagesToSend = parts && parts.length > 1 ? parts : [text]
    for (let i = 0; i < messagesToSend.length; i++) {
      if (i > 0) {
        await showTyping()
        await sleep(typingPauseMs(messagesToSend[i]))
      }
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: messagesToSend[i],
        aiGenerated: true,
      })
    }

    // After the reply lands: save the lead card and act on the outcome
    // (qualified → stage + counsellor + assigned automation; lost → stage).
    await applyLeadOutcome(db, { ...outcomeArgs, outcome, incoming: lead })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
