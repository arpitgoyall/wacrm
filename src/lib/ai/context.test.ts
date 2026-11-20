import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().not().order().limit() → { data, error }.
 *  Rows default to content_type 'text'. */
function fakeDb(rows: Record<string, unknown>[]): SupabaseClient {
  const withType = rows.map((r) => ({ content_type: 'text', ...r }))
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: withType, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})

describe('buildConversationContext — captions, taps and templates', () => {
  it('labels captions, button taps and business templates so the AI sees them', async () => {
    const rows = [
      // newest first, as the DB returns them
      { sender_type: 'customer', content_type: 'interactive', content_text: 'Yes, interested' },
      { sender_type: 'customer', content_type: 'image', content_text: 'is this the kit?' },
      { sender_type: 'bot', content_type: 'template', content_text: 'Hi Riya! Welcome to Aerocadmy 🚁' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'assistant', content: '[template message] Hi Riya! Welcome to Aerocadmy 🚁' },
      { role: 'user', content: '[sent a photo] is this the kit?' },
      { role: 'user', content: '[tapped: Yes, interested]' },
    ])
  })
})
