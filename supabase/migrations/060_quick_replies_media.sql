-- ============================================================
-- 060_quick_replies_media.sql
--
-- Lets a 'text'-kind quick reply carry a saved image/video/document
-- attachment, so "here's our pricing PDF" can be a one-click insert
-- instead of a manual attach every time.
--
-- 'interactive'-kind quick replies get media headers for free — that
-- lives entirely inside the existing `interactive_payload` JSONB (see
-- InteractiveButtonsPayload/InteractiveListPayload's new header_type /
-- header_media_url fields in src/lib/whatsapp/interactive.ts) and
-- needs no schema change.
--
-- Nullable + independent of content_text: a text quick reply can be
-- caption-only text, attachment-only, or both (mirrors how the inbox
-- composer already lets a caption ride along with any attachment).
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  -- Surfaced to the recipient for documents (mirrors messages.content_text
  -- falling back to the filename — see message-thread.tsx's handleSendMedia).
  ADD COLUMN IF NOT EXISTS media_filename TEXT;

-- A 'text' quick reply must have SOMETHING to insert — either a caption
-- or an attachment (or both). An 'interactive' row is untouched by this
-- check since its content lives in interactive_payload, not these
-- columns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quick_replies_text_has_content'
      AND conrelid = 'quick_replies'::regclass
  ) THEN
    ALTER TABLE quick_replies
      ADD CONSTRAINT quick_replies_text_has_content
      CHECK (
        kind <> 'text'
        OR content_text IS NOT NULL
        OR media_url IS NOT NULL
      );
  END IF;
END $$;
