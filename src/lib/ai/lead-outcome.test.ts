import { describe, expect, it, vi } from 'vitest'

vi.mock('./handoff-assign', () => ({
  pickHandoffAgent: vi.fn(),
  fireConversationAssigned: vi.fn(),
}))

import { formatLeadCard, mergeLeadCard } from './lead-outcome'
import { parseGeneration } from './generate'
import { withinSendHours } from './proactive'

describe('parseGeneration — [[META]] and [[SKIP]]', () => {
  it('strips the meta line and parses outcome + lead', () => {
    const r = parseGeneration(
      'Sure Riya! Fees ₹6,999 hai 😊\n[[META]] {"outcome":"qualified","lead":{"name":"Riya","goal":"","intent":"high"}}',
    )
    expect(r.text).toBe('Sure Riya! Fees ₹6,999 hai 😊')
    expect(r.outcome).toBe('qualified')
    expect(r.lead).toEqual({ name: 'Riya', intent: 'high' })
    expect(r.handoff).toBe(false)
  })

  it('treats needs_human as a handoff', () => {
    const r = parseGeneration('[[META]] {"outcome":"needs_human","lead":{}}')
    expect(r.handoff).toBe(true)
    expect(r.text).toBe('')
  })

  it('never leaks a malformed meta line to the customer', () => {
    const r = parseGeneration('Hello!\n[[META]] {not json')
    expect(r.text).toBe('Hello!')
    expect(r.outcome).toBeNull()
  })

  it('ignores unknown outcomes', () => {
    expect(parseGeneration('Hi [[META]] {"outcome":"won"}').outcome).toBeNull()
  })

  it('detects a follow-up skip', () => {
    const r = parseGeneration('[[SKIP]]\n[[META]] {"outcome":"continue"}')
    expect(r.skip).toBe(true)
    expect(r.text).toBe('')
  })

  it('keeps the old [[HANDOFF]] behaviour', () => {
    expect(parseGeneration('[[HANDOFF]]').handoff).toBe(true)
  })
})

describe('mergeLeadCard', () => {
  it('adds new facts and never erases known ones', () => {
    const { card, changed } = mergeLeadCard(
      { name: 'Riya', goal: 'career' },
      { goal: '', occupation: 'student' },
    )
    expect(changed).toBe(true)
    expect(card).toEqual({ name: 'Riya', goal: 'career', occupation: 'student' })
  })

  it('reports no change for repeated facts', () => {
    expect(mergeLeadCard({ name: 'Riya' }, { name: 'Riya' }).changed).toBe(false)
  })

  it('formats a readable note', () => {
    expect(formatLeadCard({ name: 'Riya', city: 'Pune' })).toBe('Name: Riya · City: Pune')
  })
})

describe('withinSendHours', () => {
  const ist = { sendStartHour: 9, sendEndHour: 21, timezone: 'Asia/Kolkata' }
  it('allows 10:00 IST', () => {
    // 04:30 UTC = 10:00 IST
    expect(withinSendHours(new Date('2026-11-20T04:30:00Z'), ist)).toBe(true)
  })
  it('blocks 23:00 IST', () => {
    // 17:30 UTC = 23:00 IST
    expect(withinSendHours(new Date('2026-11-20T17:30:00Z'), ist)).toBe(false)
  })
  it('supports windows that cross midnight', () => {
    const night = { sendStartHour: 22, sendEndHour: 6, timezone: 'UTC' }
    expect(withinSendHours(new Date('2026-11-20T23:00:00Z'), night)).toBe(true)
    expect(withinSendHours(new Date('2026-11-20T12:00:00Z'), night)).toBe(false)
  })
})
