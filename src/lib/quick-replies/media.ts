// ============================================================
// Shared request-body parsing for a `text`-kind quick reply's optional
// media attachment (migration 060). Used by both /api/quick-replies
// (create) and /api/quick-replies/[id] (update) so the two routes
// can't drift on what counts as a valid attachment.
// ============================================================

const ALLOWED_MEDIA_TYPES = ['image', 'video', 'document'] as const
type QuickReplyMediaType = (typeof ALLOWED_MEDIA_TYPES)[number]

export type ParseMediaFieldsResult =
  | {
      ok: true
      media_url: string | null
      media_type: QuickReplyMediaType | null
      media_filename: string | null
    }
  | { ok: false; error: string }

/**
 * Reads `media_url` / `media_type` / `media_filename` off a parsed JSON
 * body. An absent/blank `media_url` is a valid "no attachment" result —
 * callers combine it with `content_text` to enforce "needs at least
 * one" themselves, since that rule differs by call site (create
 * requires it; update only touches what's supplied).
 */
export function parseQuickReplyMediaFields(
  body: Record<string, unknown>,
): ParseMediaFieldsResult {
  const rawUrl = typeof body.media_url === 'string' ? body.media_url.trim() : ''
  if (!rawUrl) {
    return { ok: true, media_url: null, media_type: null, media_filename: null }
  }
  const rawType = typeof body.media_type === 'string' ? body.media_type : ''
  if (!ALLOWED_MEDIA_TYPES.includes(rawType as QuickReplyMediaType)) {
    return {
      ok: false,
      error: 'media_type must be "image", "video", or "document" when media_url is set.',
    }
  }
  const filename = typeof body.media_filename === 'string' ? body.media_filename.trim() : ''
  return {
    ok: true,
    media_url: rawUrl,
    media_type: rawType as QuickReplyMediaType,
    media_filename: filename || null,
  }
}
