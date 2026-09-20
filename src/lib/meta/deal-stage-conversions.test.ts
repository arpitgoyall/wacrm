import { describe, expect, it } from 'vitest'
import { metaEventForStage } from './deal-stage-conversions'

describe('metaEventForStage', () => {
  it('maps built-in CRM stages to Meta standard events', () => {
    expect(metaEventForStage('Qualified')).toBe('LeadSubmitted')
    expect(metaEventForStage(' enrolled ')).toBe('Purchase')
  })

  it('does not send conversions for other stages', () => {
    expect(metaEventForStage('New Lead')).toBeNull()
    expect(metaEventForStage('Lost')).toBeNull()
  })
})
