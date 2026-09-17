-- ============================================================
-- 061_auto_join_owner_account.sql — new signups join the owner's
-- account instead of getting their own
--
-- Product decision: this deployment is single-tenant (one business,
-- one owner) rather than the "every signup is its own isolated
-- account" SaaS model 017 introduced. The invite/join flow (018,
-- 019) remains for cases where the owner wants to hand out a
-- specific non-default role, but it is no longer the only way to
-- become a member — anyone who signs up at /signup without an
-- invite token now lands directly in the existing account as an
-- `agent`, with no separate "add to team" step and no personal
-- account created (and later discarded) along the way.
--
-- What changes
--   1. handle_new_user(): if an account already exists, attach the
--      new profile straight to it (role = 'agent') instead of
--      minting a fresh personal account. Only the very first user
--      ever (no accounts exist yet) still bootstraps a new account
--      as `owner` — that's the platform owner.
--   2. redeem_invitation(): a caller who is invited but has already
--      auto-joined the same account (the common case now, since
--      every signup lands there) gets their role updated in place
--      instead of hitting the "already a member" conflict — there's
--      no account to move between anymore.
--
-- What this does NOT change
--   - Role hierarchy, RLS policies, is_account_member() — untouched.
--   - The invite/join UI — still works, just rarer to need since
--     auto-join covers the default case.
--   - Existing multi-account data from before this migration — we
--     don't merge historical accounts; this only changes behaviour
--     for signups from here on.
--
-- Idempotent — safe to run multiple times (CREATE OR REPLACE).
-- ============================================================

-- ============================================================
-- handle_new_user() — attach to the existing account, or
-- bootstrap the first one
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  -- The primary account is the oldest one on record. In steady
  -- state there is exactly one (this deployment is single-tenant),
  -- so "oldest" and "the owner's" coincide; this only matters for
  -- picking a single, stable answer.
  SELECT id INTO v_account_id
  FROM public.accounts
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_account_id IS NULL THEN
    -- First user ever — bootstrap the account and make them owner.
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');
  ELSE
    -- Every subsequent signup auto-joins the existing account as an
    -- agent — visible to the owner immediately, no invite needed.
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'agent');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ============================================================
-- redeem_invitation() — treat "already in the target account" as
-- a role upgrade, not a conflict
--
-- Full function body restated (CREATE OR REPLACE can't patch a
-- single branch) with one change: the early exit for
-- `v_old_account_id = v_inv.account_id` now applies the invited
-- role and marks the invite accepted instead of raising 23505.
-- Everything else — locking, expiry/used checks, the sole-owner /
-- has-data safety checks on the *move* path — is unchanged from
-- 019.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Common case since 061: the caller already auto-joined this
  -- account at signup (as `agent`). There's no account to move
  -- between — just apply the role the invite was for.
  IF v_old_account_id = v_inv.account_id THEN
    UPDATE profiles
    SET account_role = v_inv.role
    WHERE user_id = v_caller_id;

    UPDATE account_invitations
    SET accepted_at = NOW(),
        accepted_by_user_id = v_caller_id
    WHERE id = v_inv.id;

    RETURN v_inv.account_id;
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
