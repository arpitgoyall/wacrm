-- Transfer selected leads, their contacts and linked inbox conversations in
-- one transaction. Deals reference profiles.id; inbox/contact assignments
-- reference profiles.user_id. Admin is the existing manager role.
CREATE OR REPLACE FUNCTION public.bulk_transfer_deals(
  p_source_profile_id UUID,
  p_target_profile_id UUID,
  p_deal_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_source_account_id UUID;
  v_target_account_id UUID;
  v_target_role public.account_role_enum;
  v_target_user_id UUID;
  v_contact_ids UUID[];
  v_conversation_ids UUID[];
  v_matched INTEGER;
  v_deals_transferred INTEGER;
  v_conversations_transferred INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Hold membership stable until all assignment writes commit.
  SELECT p.account_id, p.account_role
  INTO v_account_id, v_caller_role
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
  FOR SHARE;

  IF v_account_id IS NULL OR v_caller_role IS NULL
     OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owners and managers can transfer leads'
      USING ERRCODE = '42501';
  END IF;

  IF p_source_profile_id IS NULL OR p_target_profile_id IS NULL
     OR p_source_profile_id = p_target_profile_id THEN
    RAISE EXCEPTION 'Choose two different agents' USING ERRCODE = '22023';
  END IF;
  IF p_deal_ids IS NULL OR cardinality(p_deal_ids) = 0
     OR cardinality(p_deal_ids) > 1000 OR array_ndims(p_deal_ids) <> 1
     OR EXISTS (SELECT 1 FROM unnest(p_deal_ids) id WHERE id IS NULL)
     OR cardinality(p_deal_ids) <> (SELECT COUNT(DISTINCT id) FROM unnest(p_deal_ids) id) THEN
    RAISE EXCEPTION 'Select between 1 and 1000 unique leads'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id INTO v_source_account_id
  FROM public.profiles p
  WHERE p.id = p_source_profile_id
  FOR SHARE;

  SELECT p.account_id, p.account_role, p.user_id
  INTO v_target_account_id, v_target_role, v_target_user_id
  FROM public.profiles p
  WHERE p.id = p_target_profile_id
  FOR SHARE;

  IF v_source_account_id IS DISTINCT FROM v_account_id
     OR v_target_account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'Both agents must be members of your account'
      USING ERRCODE = '22023';
  END IF;
  IF v_target_role IS NULL OR v_target_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'The receiving member must be able to manage leads'
      USING ERRCODE = '22023';
  END IF;

  -- Lock in a consistent order, then check the original assignee. A stale
  -- selection fails the entire batch instead of overwriting a newer transfer.
  PERFORM d.id FROM public.deals d
  WHERE d.account_id = v_account_id AND d.id = ANY(p_deal_ids)
  ORDER BY d.id FOR UPDATE;

  SELECT COUNT(*) INTO v_matched
  FROM public.deals d
  WHERE d.account_id = v_account_id AND d.id = ANY(p_deal_ids)
    AND d.assigned_to = p_source_profile_id;

  IF v_matched <> cardinality(p_deal_ids) THEN
    RAISE EXCEPTION 'Some selected leads are no longer assigned to the source agent. Refresh and try again.'
      USING ERRCODE = '40001';
  END IF;

  SELECT array_agg(DISTINCT d.contact_id) FILTER (WHERE d.contact_id IS NOT NULL),
         array_agg(DISTINCT d.conversation_id) FILTER (WHERE d.conversation_id IS NOT NULL)
  INTO v_contact_ids, v_conversation_ids
  FROM public.deals d
  WHERE d.account_id = v_account_id AND d.id = ANY(p_deal_ids);

  -- A deal can retain a direct conversation link after its contact was
  -- removed. Include that conversation's contact in the ownership transfer.
  SELECT array_agg(DISTINCT linked.contact_id) INTO v_contact_ids
  FROM (
    SELECT unnest(v_contact_ids) AS contact_id
    UNION
    SELECT c.contact_id FROM public.conversations c
    WHERE c.id = ANY(v_conversation_ids)
  ) linked
  WHERE linked.contact_id IS NOT NULL;

  IF EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = ANY(v_contact_ids) AND c.account_id IS DISTINCT FROM v_account_id
  ) OR EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = ANY(v_conversation_ids) AND c.account_id IS DISTINCT FROM v_account_id
  ) THEN
    RAISE EXCEPTION 'Linked records must belong to your account'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.deals
  SET assigned_to = p_target_profile_id
  WHERE account_id = v_account_id AND id = ANY(p_deal_ids);
  GET DIAGNOSTICS v_deals_transferred = ROW_COUNT;

  -- Also move contact ownership so the recipient can edit the lead even
  -- when it has no conversation yet. Multiple selected deals may share one
  -- contact; only the selected deals change assignee.
  UPDATE public.contacts
  SET assigned_agent_id = v_target_user_id
  WHERE account_id = v_account_id AND id = ANY(v_contact_ids)
    AND assigned_agent_id IS DISTINCT FROM v_target_user_id;

  UPDATE public.conversations
  SET assigned_agent_id = v_target_user_id
  WHERE account_id = v_account_id
    AND (contact_id = ANY(v_contact_ids) OR id = ANY(v_conversation_ids))
    AND assigned_agent_id IS DISTINCT FROM v_target_user_id;
  GET DIAGNOSTICS v_conversations_transferred = ROW_COUNT;
  -- Existing conversation-assignment triggers create recipient notifications.

  RETURN jsonb_build_object(
    'dealsTransferred', v_deals_transferred,
    'conversationsTransferred', v_conversations_transferred
  );
END;
$$;

ALTER FUNCTION public.bulk_transfer_deals(UUID, UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bulk_transfer_deals(UUID, UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_transfer_deals(UUID, UUID, UUID[]) TO authenticated;
