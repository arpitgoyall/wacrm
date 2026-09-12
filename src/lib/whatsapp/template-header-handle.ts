import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE, VIDEO, or DOCUMENT
 * header — a plain public URL in `example.header_url` is NOT accepted
 * at creation time despite `buildHeaderComponent` sending it as a
 * fallback (issue: DOCUMENT-header submissions failed with Meta's
 * "Missing sample parameter" error because this helper was image-only
 * and nothing produced a handle for document/video). This helper turns
 * the template's `header_media_url` (whether the user uploaded a file
 * or pasted a link) into a handle and writes it onto the payload, so
 * both the upload path and the legacy URL path actually succeed for
 * all three media header types.
 *
 * No-op unless the header is image/video/document, has a URL, and has
 * no handle yet.
 */

// Meta's per-format header-sample constraints. Mirrors the client-side
// upload caps in template-manager.tsx (`HEADER_MEDIA_ACCEPT` /
// `MEDIA_MAX_BYTES_BY_KIND`) so a file the UI accepted never fails
// this server-side re-check, and a manually-pasted URL is held to the
// same bar.
const HEADER_MEDIA_LIMITS: Record<
  'image' | 'video' | 'document',
  { allowedTypes: readonly string[]; maxBytes: number; label: string }
> = {
  image: { allowedTypes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, label: 'JPEG or PNG' },
  video: { allowedTypes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * 1024 * 1024, label: 'MP4 or 3GPP' },
  document: { allowedTypes: ['application/pdf'], maxBytes: 16 * 1024 * 1024, label: 'a PDF' },
}

function extensionFor(format: 'image' | 'video' | 'document', mimeType: string): string {
  if (format === 'image') return mimeType === 'image/png' ? 'png' : 'jpg'
  if (format === 'video') return mimeType === 'video/3gpp' ? '3gp' : 'mp4'
  return 'pdf'
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const format = payload.header_type
  if (format !== 'image' && format !== 'video' && format !== 'document') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const limits = HEADER_MEDIA_LIMITS[format]

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Media-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the header.',
    )
  }

  // SSRF guard: `header_media_url` is caller-supplied (any authenticated
  // member can submit a template) and the fetch below happens server-side,
  // so refuse any destination that resolves to a private / loopback /
  // link-local / reserved address. Same guard, same message as the two
  // other outbound-fetch call sites (see lib/webhooks/ssrf.ts) — matching
  // the unreachable-host message keeps the failure from being an oracle.
  if (!(await isDeliverableUrl(payload.header_media_url))) {
    throw new Error('Could not fetch the header file URL. Make sure it is publicly reachable.')
  }

  // Fetch the sample bytes (works for our uploaded chat-media URL and
  // for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, {
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, defeating the guard above. Bound the request so
      // a hung host can't tie up the template-submit handler.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Could not fetch the header file URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header file URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !limits.allowedTypes.includes(contentType)) {
    throw new Error(`Header ${format} must be ${limits.label} (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${format} is empty.`)
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new Error(
      `Header ${format} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    )
  }

  const mimeType = limits.allowedTypes.includes(contentType) ? contentType : limits.allowedTypes[0]
  const fileName = `header.${extensionFor(format, mimeType)}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
