-- Stage-specific deal fields. Definitions live on the stage; values live on
-- the deal so they survive a move away from and back to a stage.
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_custom_fields_array
  CHECK (jsonb_typeof(custom_fields) = 'array');

ALTER TABLE deals
  ADD CONSTRAINT deals_custom_values_object
  CHECK (jsonb_typeof(custom_values) = 'object');

-- Required stage fields must be populated on creation and whenever a deal is
-- moved or edited. This protects non-form update paths too (board, inbox,
-- automations, and direct API writes).
CREATE OR REPLACE FUNCTION validate_deal_stage_custom_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  field JSONB;
  field_id TEXT;
  field_label TEXT;
BEGIN
  FOR field IN
    SELECT value
    FROM jsonb_array_elements(
      COALESCE(
        (SELECT custom_fields FROM pipeline_stages WHERE id = NEW.stage_id),
        '[]'::jsonb
      )
    )
  LOOP
    IF COALESCE((field->>'required')::boolean, false) THEN
      field_id := field->>'id';
      field_label := COALESCE(NULLIF(field->>'label', ''), 'Custom field');
      IF field_id IS NULL
        OR btrim(COALESCE(NEW.custom_values->>field_id, '')) = ''
        OR (
          field->>'type' = 'dropdown'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(field->'options', '[]'::jsonb)) option
            WHERE option = NEW.custom_values->>field_id
          )
        ) THEN
        RAISE EXCEPTION 'Required stage field "%" is missing', field_label
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_deal_stage_custom_fields_trigger ON deals;
CREATE TRIGGER validate_deal_stage_custom_fields_trigger
  BEFORE INSERT OR UPDATE OF stage_id, custom_values ON deals
  FOR EACH ROW EXECUTE FUNCTION validate_deal_stage_custom_fields();
