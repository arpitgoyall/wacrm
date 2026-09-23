-- Track who sent the newest message so the Inbox can distinguish a thread
-- awaiting an agent reply from the unrelated open/pending/closed status.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_sender_type text
  CHECK (last_message_sender_type IN ('customer', 'agent', 'bot'));

-- Populate existing conversations from their newest stored message.
UPDATE public.conversations AS c
SET last_message_sender_type = (
  SELECT m.sender_type
  FROM public.messages AS m
  WHERE m.conversation_id = c.id
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
)
WHERE c.last_message_sender_type IS NULL
  AND EXISTS (
    SELECT 1 FROM public.messages AS m WHERE m.conversation_id = c.id
  );

CREATE OR REPLACE FUNCTION public.sync_conversation_last_message_sender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_sender_type = NEW.sender_type
  WHERE id = NEW.conversation_id
    AND (last_message_at IS NULL OR NEW.created_at >= last_message_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_sync_conversation_last_sender ON public.messages;
CREATE TRIGGER messages_sync_conversation_last_sender
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.sync_conversation_last_message_sender();
