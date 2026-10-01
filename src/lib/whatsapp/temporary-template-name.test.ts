import { describe, expect, it } from 'vitest'
import { isTemporaryTemplateName } from './temporary-template-name'

describe('temporary inbox template names', () => {
  it('matches generated one-use names without hiding similarly named reusable templates', () => {
    expect(isTemporaryTemplateName('inbox_0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isTemporaryTemplateName('inbox_follow_up')).toBe(false)
    expect(isTemporaryTemplateName('inbox_0123456789abcdef0123456789abcdeg')).toBe(false)
  })
})
