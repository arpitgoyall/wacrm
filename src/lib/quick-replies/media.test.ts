import { describe, expect, it } from 'vitest'
import { parseQuickReplyMediaFields } from './media'

describe('parseQuickReplyMediaFields', () => {
  it('returns all-null when media_url is absent', () => {
    expect(parseQuickReplyMediaFields({})).toEqual({
      ok: true,
      media_url: null,
      media_type: null,
      media_filename: null,
    })
  })

  it('returns all-null when media_url is blank', () => {
    expect(parseQuickReplyMediaFields({ media_url: '  ' })).toEqual({
      ok: true,
      media_url: null,
      media_type: null,
      media_filename: null,
    })
  })

  it('rejects a media_url with no media_type', () => {
    const result = parseQuickReplyMediaFields({ media_url: 'https://x.test/a.pdf' })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown media_type', () => {
    const result = parseQuickReplyMediaFields({
      media_url: 'https://x.test/a.ogg',
      media_type: 'audio',
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a valid image attachment with no filename', () => {
    expect(
      parseQuickReplyMediaFields({
        media_url: 'https://x.test/promo.jpg',
        media_type: 'image',
      }),
    ).toEqual({
      ok: true,
      media_url: 'https://x.test/promo.jpg',
      media_type: 'image',
      media_filename: null,
    })
  })

  it('accepts a valid document attachment with a filename', () => {
    expect(
      parseQuickReplyMediaFields({
        media_url: 'https://x.test/pricing.pdf',
        media_type: 'document',
        media_filename: 'pricing.pdf',
      }),
    ).toEqual({
      ok: true,
      media_url: 'https://x.test/pricing.pdf',
      media_type: 'document',
      media_filename: 'pricing.pdf',
    })
  })

  it('trims the url and filename', () => {
    const result = parseQuickReplyMediaFields({
      media_url: '  https://x.test/clip.mp4  ',
      media_type: 'video',
      media_filename: '  clip.mp4  ',
    })
    expect(result).toEqual({
      ok: true,
      media_url: 'https://x.test/clip.mp4',
      media_type: 'video',
      media_filename: 'clip.mp4',
    })
  })
})
