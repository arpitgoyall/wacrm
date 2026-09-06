-- Shared contact table display configuration. Members can read it through
-- the existing accounts SELECT policy; the existing accounts UPDATE policy
-- limits changes to owners and admins.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS contact_table_columns TEXT[] NOT NULL DEFAULT ARRAY[
    'name', 'phone', 'email', 'company', 'tags', 'created_at'
  ];

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_contact_table_columns_valid;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_contact_table_columns_valid
  CHECK (
    cardinality(contact_table_columns) > 0
    AND contact_table_columns <@ ARRAY['name', 'phone', 'email', 'company', 'tags', 'created_at']::TEXT[]
  );