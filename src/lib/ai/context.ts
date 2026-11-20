import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

/** Message kinds that carry text the model can use. Audio and location
 *  rows have nothing readable, so they're left out. */
const READABLE_TYPES = ['text', 'image', 'video', 'document', 'interactive', 'template']

/**
 * How a non-plain-text message reads in the transcript, so the model knows
 * what it was: a photo caption, a button the customer tapped, or a
 * template the business sent (e.g. the new-lead greeting or a broadcast,
 * which the model must see to avoid repeating or contradicting it).
 */
export function transcriptLine(m: DbMessage): string {
  const text = (m.content_text ?? '').trim()
  switch (m.content_type) {
    case 'image':
      return `[sent a photo] ${text}`
    case 'video':
      return `[sent a video] ${text}`
    case 'document':
      return `[sent a file] ${text}`
    case 'interactive':
      return m.sender_type === 'customer' ? `[tapped: ${text}]` : text
    case 'template':
      return m.sender_type === 'customer' ? text : `[template message] ${text}`
    default:
      return text
  }
}

/**
 * Fetch the last N readable messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent and
 * bot messages become `assistant`. Includes captions, button taps and
 * template messages (labelled) alongside plain text; messages with no text
 * (voice notes, locations, uncaptioned media) are excluded.
 *
 * Ordered oldest-first (chronological) so the transcript reads naturally
 * and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', READABLE_TYPES)
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: transcriptLine(m).trim(),
    }))
}
