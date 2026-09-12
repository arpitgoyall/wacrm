/**
 * Shared file-picker `accept` lists for a real chat-message attachment
 * (composer, interactive-message headers, quick-reply attachments).
 *
 * NOT the same as a WhatsApp *template* header's constraints
 * (`HEADER_MEDIA_ACCEPT` in template-manager.tsx / template-header-
 * handle.ts) — Meta's template review pipeline is stricter (no WEBP,
 * DOCUMENT headers are PDF-only). These lists mirror the chat-media
 * bucket's allowed_mime_types (migration 023), which is the broader,
 * "will this actually send as a normal message" bar. Audio has no
 * picker — it's captured via the recorder.
 */
export const CHAT_MEDIA_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};
