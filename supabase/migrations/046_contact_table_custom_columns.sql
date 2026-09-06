-- Allow account admins to include account-owned custom fields in the
-- shared Contacts table view. Standard column ids remain validated too.
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_contact_table_columns_valid;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_contact_table_columns_valid
  CHECK (
    cardinality(contact_table_columns) > 0
    AND array_to_string(contact_table_columns, ',') ~ '^(name|phone|email|company|tags|created_at|custom:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(,(name|phone|email|company|tags|created_at|custom:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))*$'
  );