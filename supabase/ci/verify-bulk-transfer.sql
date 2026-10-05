-- Run after migrations against a disposable database. One statement for
-- `supabase db query --file`; all fixtures roll back before it returns.
DO $$
DECLARE
  v_owner UUID := gen_random_uuid();
  v_manager UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_target UUID := gen_random_uuid();
  v_viewer UUID := gen_random_uuid();
  v_foreign UUID := gen_random_uuid();
  v_account UUID;
  v_foreign_account UUID;
  v_source_profile UUID;
  v_target_profile UUID;
  v_viewer_profile UUID;
  v_foreign_profile UUID;
  v_pipeline UUID := gen_random_uuid();
  v_stage UUID := gen_random_uuid();
  v_contact UUID := gen_random_uuid();
  v_no_inbox_contact UUID := gen_random_uuid();
  v_direct_contact UUID := gen_random_uuid();
  v_other_contact UUID := gen_random_uuid();
  v_conversation UUID := gen_random_uuid();
  v_direct_conversation UUID := gen_random_uuid();
  v_other_conversation UUID := gen_random_uuid();
  v_deal UUID := gen_random_uuid();
  v_no_inbox_deal UUID := gen_random_uuid();
  v_direct_deal UUID := gen_random_uuid();
  v_unselected_deal UUID := gen_random_uuid();
  v_other_deal UUID := gen_random_uuid();
  v_result JSONB;
  v_user UUID;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO auth.users (id, email)
    VALUES (v_owner, v_owner || '@transfer.test'),
           (v_manager, v_manager || '@transfer.test'),
           (v_source, v_source || '@transfer.test'),
           (v_target, v_target || '@transfer.test'),
           (v_viewer, v_viewer || '@transfer.test'),
           (v_foreign, v_foreign || '@transfer.test');

    INSERT INTO public.accounts (name, owner_user_id)
    VALUES ('Bulk transfer test', v_owner)
    ON CONFLICT (owner_user_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_account;
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES ('Other transfer account', v_foreign)
    ON CONFLICT (owner_user_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_foreign_account;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Owner', v_owner || '@transfer.test', v_account, 'owner'),
           (v_manager, 'Manager', v_manager || '@transfer.test', v_account, 'admin'),
           (v_source, 'Source', v_source || '@transfer.test', v_account, 'agent'),
           (v_target, 'Target', v_target || '@transfer.test', v_account, 'agent'),
           (v_viewer, 'Viewer', v_viewer || '@transfer.test', v_account, 'viewer'),
           (v_foreign, 'Foreign', v_foreign || '@transfer.test', v_foreign_account, 'owner')
    ON CONFLICT (user_id) DO UPDATE
      SET account_id = EXCLUDED.account_id, account_role = EXCLUDED.account_role;

    SELECT id INTO v_source_profile FROM public.profiles WHERE user_id = v_source;
    SELECT id INTO v_target_profile FROM public.profiles WHERE user_id = v_target;
    SELECT id INTO v_viewer_profile FROM public.profiles WHERE user_id = v_viewer;
    SELECT id INTO v_foreign_profile FROM public.profiles WHERE user_id = v_foreign;

    INSERT INTO public.pipelines (id, user_id, account_id, name)
    VALUES (v_pipeline, v_owner, v_account, 'Transfer test');
    INSERT INTO public.pipeline_stages (id, pipeline_id, name, color, position)
    VALUES (v_stage, v_pipeline, 'New Lead', '#3b82f6', 0);
    INSERT INTO public.contacts (id, user_id, account_id, phone, assigned_agent_id)
    VALUES (v_contact, v_owner, v_account, '+10000000001', v_source),
           (v_no_inbox_contact, v_owner, v_account, '+10000000002', v_source),
           (v_direct_contact, v_owner, v_account, '+10000000003', v_source),
           (v_other_contact, v_owner, v_account, '+10000000004', v_source);
    INSERT INTO public.conversations (id, user_id, account_id, contact_id, assigned_agent_id)
    VALUES (v_conversation, v_owner, v_account, v_contact, v_source),
           (v_direct_conversation, v_owner, v_account, v_direct_contact, v_source),
           (v_other_conversation, v_owner, v_account, v_other_contact, v_source);
    INSERT INTO public.deals (id, user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id, title, assigned_to)
    VALUES (v_deal, v_owner, v_account, v_pipeline, v_stage, v_contact, NULL, 'Selected', v_source_profile),
           (v_no_inbox_deal, v_owner, v_account, v_pipeline, v_stage, v_no_inbox_contact, NULL, 'No inbox', v_source_profile),
           (v_direct_deal, v_owner, v_account, v_pipeline, v_stage, NULL, v_direct_conversation, 'Direct inbox link', v_source_profile),
           (v_unselected_deal, v_owner, v_account, v_pipeline, v_stage, v_contact, NULL, 'Shared contact, unselected', v_source_profile),
           (v_other_deal, v_owner, v_account, v_pipeline, v_stage, v_other_contact, NULL, 'Unrelated', v_source_profile);

    -- Direct RPC callers are subject to the same role checks as the API.
    FOREACH v_user IN ARRAY ARRAY[v_source, v_viewer] LOOP
      PERFORM set_config('request.jwt.claim.sub', v_user::TEXT, true);
      BEGIN
        PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal]);
        RAISE EXCEPTION 'An agent/viewer was allowed to transfer leads';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'An anonymous caller was allowed to transfer leads';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    PERFORM set_config('request.jwt.claim.sub', v_manager::TEXT, true);
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_foreign_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A cross-account destination was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_foreign_profile, v_target_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A cross-account source was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_viewer_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A viewer destination was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_source_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A same-agent transfer was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal, v_deal]);
      RAISE EXCEPTION 'Duplicate lead IDs were accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[]::UUID[]);
      RAISE EXCEPTION 'An empty transfer was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal, NULL]::UUID[]);
      RAISE EXCEPTION 'A null lead ID was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, array_fill(v_deal, ARRAY[1001]));
      RAISE EXCEPTION 'An oversized batch was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal, gen_random_uuid()]);
      RAISE EXCEPTION 'A batch containing a missing lead was accepted';
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
    BEGIN
      PERFORM public.bulk_transfer_deals(v_target_profile, v_source_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A stale source assignee was accepted';
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;

    -- Fail the last table update and verify earlier deal/contact writes
    -- roll back too. This trigger itself rolls back with the test block.
    BEGIN
      EXECUTE $trigger_function$
        CREATE FUNCTION public.bulk_transfer_ci_fail() RETURNS TRIGGER
        LANGUAGE plpgsql AS $body$
        BEGIN
          RAISE EXCEPTION 'Simulated inbox failure' USING ERRCODE = 'BT001';
        END;
        $body$
      $trigger_function$;
      EXECUTE 'CREATE TRIGGER bulk_transfer_ci_fail BEFORE UPDATE OF assigned_agent_id ON public.conversations
               FOR EACH ROW EXECUTE FUNCTION public.bulk_transfer_ci_fail()';
      PERFORM public.bulk_transfer_deals(v_source_profile, v_target_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'The simulated failure did not run';
    EXCEPTION WHEN SQLSTATE 'BT001' THEN NULL;
    END;
    IF EXISTS (SELECT 1 FROM public.deals WHERE id = v_deal AND assigned_to <> v_source_profile)
       OR EXISTS (SELECT 1 FROM public.contacts WHERE id = v_contact AND assigned_agent_id <> v_source)
       OR EXISTS (SELECT 1 FROM public.conversations WHERE id = v_conversation AND assigned_agent_id <> v_source) THEN
      RAISE EXCEPTION 'A failed transfer partially changed assignments';
    END IF;

    v_result := public.bulk_transfer_deals(
      v_source_profile, v_target_profile, ARRAY[v_deal, v_no_inbox_deal, v_direct_deal]
    );
    IF v_result <> jsonb_build_object('dealsTransferred', 3, 'conversationsTransferred', 2) THEN
      RAISE EXCEPTION 'Unexpected transfer counts: %', v_result;
    END IF;
    IF (SELECT COUNT(*) FROM public.deals WHERE id = ANY(ARRAY[v_deal, v_no_inbox_deal, v_direct_deal])
        AND assigned_to = v_target_profile) <> 3 THEN
      RAISE EXCEPTION 'Selected deals were not assigned to the destination profile';
    END IF;
    IF (SELECT COUNT(*) FROM public.contacts WHERE id = ANY(ARRAY[v_contact, v_no_inbox_contact, v_direct_contact])
        AND assigned_agent_id = v_target) <> 3 THEN
      RAISE EXCEPTION 'Linked contacts were not assigned to the destination user';
    END IF;
    IF (SELECT COUNT(*) FROM public.conversations WHERE id = ANY(ARRAY[v_conversation, v_direct_conversation])
        AND assigned_agent_id = v_target) <> 2 THEN
      RAISE EXCEPTION 'Linked inbox conversations were not assigned to the destination user';
    END IF;
    IF (SELECT COUNT(*) FROM public.notifications WHERE user_id = v_target
        AND conversation_id = ANY(ARRAY[v_conversation, v_direct_conversation])) <> 2 THEN
      RAISE EXCEPTION 'The receiving agent did not get assignment notifications';
    END IF;
    IF (SELECT COUNT(*) FROM public.deals WHERE id = ANY(ARRAY[v_unselected_deal, v_other_deal])
        AND assigned_to = v_source_profile) <> 2
       OR NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = v_other_contact AND assigned_agent_id = v_source)
       OR NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = v_other_conversation AND assigned_agent_id = v_source) THEN
      RAISE EXCEPTION 'Unselected deals or unrelated inbox records were changed';
    END IF;

    -- The recipient can access the transferred conversations, and the
    -- original agent loses access under the existing inbox visibility rule.
    PERFORM set_config('request.jwt.claim.sub', v_target::TEXT, true);
    IF NOT public.can_view_conversation(v_account, v_target) THEN
      RAISE EXCEPTION 'The receiving agent cannot access the transferred inbox';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_source::TEXT, true);
    IF public.can_view_conversation(v_account, v_target) THEN
      RAISE EXCEPTION 'The source agent can still access the transferred inbox';
    END IF;

    -- Owners can transfer back; a repeated stale request must fail.
    PERFORM set_config('request.jwt.claim.sub', v_owner::TEXT, true);
    PERFORM public.bulk_transfer_deals(v_target_profile, v_source_profile, ARRAY[v_deal]);
    BEGIN
      PERFORM public.bulk_transfer_deals(v_target_profile, v_source_profile, ARRAY[v_deal]);
      RAISE EXCEPTION 'A repeated stale transfer was accepted';
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;

    RAISE NOTICE 'bulk transfer verification passed';
    RAISE EXCEPTION 'Roll back test fixtures' USING ERRCODE = 'BT999';
  EXCEPTION WHEN SQLSTATE 'BT999' THEN NULL;
  END;
END;
$$;
