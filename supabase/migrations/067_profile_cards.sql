-- Per-member public profile-card image used by assignment automations.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS profile_card TEXT;
