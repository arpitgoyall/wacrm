-- A composed message can wait for Meta to approve its one-use template.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('sending', 'pending_approval', 'sent', 'delivered', 'read', 'failed', 'rejected'));
CREATE INDEX IF NOT EXISTS idx_messages_pending_template
  ON messages(template_name) WHERE status = 'pending_approval';
