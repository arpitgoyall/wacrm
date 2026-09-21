import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const sendMediaMessage = vi.fn()
  const messageInsert = vi.fn()
  const conversationEq = vi.fn()
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'contacts') {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({
            data: { id: 'contact-1', phone: '+919999999999' },
            error: null,
          })),
        }
        return query
      }
      if (table === 'whatsapp_config') {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          single: vi.fn(async () => ({
            data: { phone_number_id: 'phone-1', access_token: 'encrypted' },
            error: null,
          })),
        }
        return query
      }
      if (table === 'messages') return { insert: messageInsert }
      if (table === 'conversations') {
        return { update: vi.fn(() => ({ eq: conversationEq })) }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  }
  return { sendMediaMessage, messageInsert, conversationEq, db }
})

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendMediaMessage: mocks.sendMediaMessage,
  sendTextMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (phone: string) => phone,
  isValidE164: () => true,
  phoneVariants: (phone: string) => [phone],
  isRecipientNotAllowedError: () => false,
}))
vi.mock('./admin-client', () => ({ supabaseAdmin: () => mocks.db }))

import { engineSendMedia } from './meta-send'

describe('engineSendMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMediaMessage.mockResolvedValue({ messageId: 'wamid.image-1' })
    mocks.messageInsert.mockResolvedValue({ error: null })
    mocks.conversationEq.mockResolvedValue({ error: null })
  })

  it('persists the media URL used for the Meta send', async () => {
    await engineSendMedia({
      accountId: 'account-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      kind: 'image',
      link: 'https://cdn.example/drone.jpg',
      caption: 'Drone kit',
    })

    expect(mocks.messageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: 'image',
        content_text: 'Drone kit',
        media_url: 'https://cdn.example/drone.jpg',
        message_id: 'wamid.image-1',
      }),
    )
  })
})
