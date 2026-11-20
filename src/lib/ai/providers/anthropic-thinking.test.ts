import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicThinkingParam, generateAnthropic } from './anthropic'

describe('anthropicThinkingParam', () => {
  it('turns thinking off for Claude Haiku 5.5', () => {
    expect(anthropicThinkingParam('claude-haiku-5-5')).toEqual({ type: 'disabled' })
  })
  it('uses between_tools for Claude Sonnet 5.5 (disabled is rejected there)', () => {
    expect(anthropicThinkingParam('claude-sonnet-5-5')).toEqual({ type: 'between_tools' })
  })
  it('leaves other models on their default', () => {
    expect(anthropicThinkingParam('claude-haiku-4-5')).toBeUndefined()
    expect(anthropicThinkingParam('claude-opus-5-5')).toBeUndefined()
  })
})

describe('generateAnthropic request body', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends thinking:disabled for Haiku 5.5 and omits it otherwise', async () => {
    // A fresh Response per call — a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi!' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const base = {
      apiKey: 'k',
      systemPrompt: 's',
      messages: [{ role: 'user' as const, content: 'hello' }],
      timeoutMs: 1000,
    }
    await generateAnthropic({ ...base, model: 'claude-haiku-5-5' })
    await generateAnthropic({ ...base, model: 'claude-opus-5-5' })
    const haiku = JSON.parse(fetchMock.mock.calls[0][1].body)
    const opus = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(haiku.thinking).toEqual({ type: 'disabled' })
    expect(opus).not.toHaveProperty('thinking')
  })
})
