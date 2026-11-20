import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  pickHandoffAgent: vi.fn(),
  fireConversationAssigned: vi.fn(),
  loadLeadContact: vi.fn(),
  applyLeadOutcome: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    /** Whether the guarded handoff update matches (false = already handed off). */
    handoffClaim: true as boolean,
    /** wamid of the newest customer message (debounce check). */
    latestCustomerMsgId: null as string | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./lead-outcome', () => ({
  loadLeadContact: h.loadLeadContact,
  applyLeadOutcome: h.applyLeadOutcome,
}))
vi.mock('./handoff-assign', () => ({
  pickHandoffAgent: h.pickHandoffAgent,
  fireConversationAssigned: h.fireConversationAssigned,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'messages' || table === 'whatsapp_config') {
        // Debounce lookup: newest customer message. (whatsapp_config has
        // no creds here, so the typing indicator is skipped.)
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: table === 'messages' ? { message_id: h.state.latestCustomerMsgId } : null,
              error: null,
            }),
        }
        return chain
      }
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          // Chainable + awaitable: supports both `.eq()` and the guarded
          // handoff's `.eq().eq().is().select()`.
          const chain: Record<string, unknown> = {
            eq: () => chain,
            is: () => chain,
            select: () =>
              Promise.resolve({ data: h.state.handoffClaim ? [{ id: 'conv-1' }] : [], error: null }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(resolve),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.handoffClaim = true
  h.state.latestCustomerMsgId = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.pickHandoffAgent.mockReset().mockResolvedValue('agent-auto')
  h.fireConversationAssigned.mockReset().mockResolvedValue(undefined)
  h.loadLeadContact.mockReset().mockResolvedValue({ card: {}, name: null, phone: null })
  h.applyLeadOutcome.mockReset().mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('hands off (never goes silent) when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-auto',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('reply limit')
    expect(h.fireConversationAssigned).toHaveBeenCalledTimes(1)
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('pauses the bot, writes a summary, sends nothing, and auto-assigns the least-busy agent', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    // The customer-facing message is the account's conversation_assigned
    // automation's job, not the AI's.
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-auto',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    expect(h.fireConversationAssigned).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        agentId: 'agent-auto',
      }),
    )
  })

  it('routes to the configured handoff agent and fires the assigned automation', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.pickHandoffAgent).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
    expect(h.fireConversationAssigned).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: 'agent-7' }),
    )
  })

  it('leaves the chat unassigned and fires no automation when nobody is available', async () => {
    h.pickHandoffAgent.mockResolvedValue(null)
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
    expect(h.fireConversationAssigned).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — lead outcomes', () => {
  it('sends the reply, then applies the qualified outcome with the learned card', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Awesome! Connecting you with our counsellor 😊',
      handoff: false,
      outcome: 'qualified',
      lead: { name: 'Riya', occupation: 'B.Tech student', goal: 'drone career' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.applyLeadOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'qualified',
        incoming: { name: 'Riya', occupation: 'B.Tech student', goal: 'drone career' },
        conversationId: 'conv-1',
        contactId: 'contact-1',
      }),
    )
    // The send must land before the outcome is acted on.
    expect(h.engineSendText.mock.invocationCallOrder[0]).toBeLessThan(
      h.applyLeadOutcome.mock.invocationCallOrder[0],
    )
  })

  it('does not apply an outcome when the reply is never sent (cap race lost)', async () => {
    h.state.claim = false
    h.generateReply.mockResolvedValue({ text: 'Hi', handoff: false, outcome: 'lost' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyLeadOutcome).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — human-like split replies', () => {
  it('sends each part in order as its own message, claiming one reply slot', async () => {
    vi.useFakeTimers()
    try {
      h.generateReply.mockResolvedValue({
        text: 'Hey!\n\nFees ₹6,999.\n\nWant the brochure?',
        parts: ['Hey!', 'Fees ₹6,999.', 'Want the brochure?'],
        handoff: false,
      })
      const run = dispatchInboundToAiReply(ARGS)
      await vi.runAllTimersAsync()
      await run
      expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([
        'Hey!',
        'Fees ₹6,999.',
        'Want the brochure?',
      ])
      expect(h.state.rpcCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('typingPauseMs', () => {
  it('stays between 1.2s and 4s', async () => {
    const { typingPauseMs } = await import('./auto-reply')
    expect(typingPauseMs('ok')).toBe(1200)
    expect(typingPauseMs('x'.repeat(500))).toBe(4000)
  })
})

describe('dispatchInboundToAiReply — media and races', () => {
  it('hands a voice note to a human without calling the model', async () => {
    await dispatchInboundToAiReply({ ...ARGS, inboundKind: 'unreadable' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('voice note')
    expect(h.fireConversationAssigned).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a sticker / reaction', async () => {
    await dispatchInboundToAiReply({ ...ARGS, inboundKind: 'ignore' })
    expect(h.loadAiConfig).not.toHaveBeenCalled()
  })

  it('does not assign or fire the automation twice when the chat was already handed off', async () => {
    h.state.handoffClaim = false // a concurrent run won the guarded update
    await dispatchInboundToAiReply({ ...ARGS, inboundKind: 'unreadable' })
    expect(h.fireConversationAssigned).not.toHaveBeenCalled()
  })

  it('hands off when it loses the race for the last reply slot', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('reply limit')
  })
})

describe('classifyInbound', () => {
  it.each([
    ['text', 'hi', 'text'],
    ['interactive', 'Yes, interested', 'text'],
    ['button', 'Know more', 'text'],
    ['image', 'is this the kit?', 'text'],
    ['image', '', 'unreadable'],
    ['audio', '', 'unreadable'],
    ['document', 'resume.pdf', 'unreadable'],
    ['location', 'Pune', 'unreadable'],
    ['sticker', '', 'ignore'],
    ['reaction', '👍', 'ignore'],
    ['text', '   ', 'ignore'],
  ])('%s with "%s" → %s', async (type, text, expected) => {
    const { classifyInbound } = await import('./auto-reply')
    expect(classifyInbound(type, text)).toBe(expected)
  })
})

describe('dispatchInboundToAiReply — quick-succession debounce', () => {
  async function runWithTimers(args: Parameters<typeof dispatchInboundToAiReply>[0]) {
    vi.useFakeTimers()
    try {
      const run = dispatchInboundToAiReply(args)
      await vi.runAllTimersAsync()
      await run
    } finally {
      vi.useRealTimers()
    }
  }

  it('stands down when the customer sent a newer message (that run answers all of it)', async () => {
    h.state.latestCustomerMsgId = 'wamid.NEWER'
    await runWithTimers({ ...ARGS, inboundMessageId: 'wamid.OLDER' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies when this is still the newest message', async () => {
    h.state.latestCustomerMsgId = 'wamid.ONLY'
    await runWithTimers({ ...ARGS, inboundMessageId: 'wamid.ONLY' })
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})
