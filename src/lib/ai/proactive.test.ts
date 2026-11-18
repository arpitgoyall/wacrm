import { describe, expect, it, vi } from 'vitest'

vi.mock('./admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: vi.fn() }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: vi.fn() }))

import { isOptOutText } from './proactive'
import { buildSystemPrompt } from './defaults'

describe('isOptOutText', () => {
  it.each([
    'STOP',
    'please stop messaging me',
    'Not interested',
    'mat bhejo yaar',
    'nahi chahiye',
    "don't contact me",
  ])('detects opt-out: %s', (t) => expect(isOptOutText(t)).toBe(true))

  it.each(['What is the price?', 'kitna hoga?', '', null])(
    'ignores normal text: %s',
    (t) => expect(isOptOutText(t as string | null)).toBe(false),
  )
})

describe('buildSystemPrompt', () => {
  it('teaches English default + Hinglish mirroring', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).toMatch(/default to English/)
    expect(p).toMatch(/Hinglish/)
  })

  it('adds re-engagement guidance only for follow-ups', () => {
    const base = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    const f = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      followup: { attempt: 2, maxAttempts: 3, hoursSilent: 26 },
    })
    expect(base).not.toMatch(/Re-engagement/)
    expect(f).toMatch(/follow-up 2 of 3/)
  })
})
