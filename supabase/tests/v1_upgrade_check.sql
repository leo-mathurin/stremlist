-- Step 2 of the upgrade test. Run after the v2 migrations were applied on
-- top of supabase/tests/v1_upgrade_seed.sql. It checks that every v1 row
-- survived the migration, that v1 and v2 both read it, and then deletes the
-- seeded rows.
BEGIN;

DO $$
DECLARE
  legacy record;
BEGIN
  -- Every Legacy ID survived as is, with a generated Account ID.
  ASSERT (SELECT count(*) FROM public.accounts WHERE legacy_imdb_user_id IN
    ('ur7200001', 'p.upgradehandle', 'ls7200002', 'ur72abc00x9', '  junk / id  ')) = 5;
  ASSERT NOT EXISTS (SELECT 1 FROM public.accounts
    WHERE legacy_imdb_user_id IN ('ur7200001', 'p.upgradehandle', 'ls7200002',
      'ur72abc00x9', '  junk / id  ')
    AND id !~ '^sl_[0-9A-Za-z]{22}$');

  SELECT * INTO legacy FROM public.accounts WHERE legacy_imdb_user_id = 'ur7200001';
  ASSERT legacy.rpdb_api_key = 'rpdb-1';
  ASSERT legacy.last_fetched_at = '2026-01-01T00:00:00Z';
  ASSERT legacy.prewarm_lease_token = '74444444-4444-4444-8444-444444444444';
  ASSERT legacy.prewarm_request_generation = 1;
  ASSERT NOT (SELECT is_active FROM public.accounts WHERE legacy_imdb_user_id = 'ls7200002');

  -- Lists moved to the Account, as IMDb Lists, with their settings.
  ASSERT (SELECT count(*) FROM public.lists WHERE account_id = legacy.id
    AND provider = 'imdb') = 2;
  ASSERT (SELECT catalog_settings FROM public.lists
    WHERE id = '73333333-3333-4333-8333-333333333333') = '{"minRating":7}';
  ASSERT (SELECT source_ref FROM public.lists l JOIN public.accounts a ON a.id = l.account_id
    WHERE a.legacy_imdb_user_id = '  junk / id  ') = '  junk / id  ';

  -- v1 still reads the same rows.
  SET LOCAL ROLE service_role;
  ASSERT (SELECT count(*) FROM public.users WHERE imdb_user_id IN
    ('ur7200001', 'p.upgradehandle', 'ls7200002', 'ur72abc00x9', '  junk / id  ')) = 5;
  ASSERT (SELECT count(*) FROM public.user_watchlists
    WHERE owner_user_id = 'ur7200001') = 2;
  ASSERT (SELECT imdb_user_id FROM public.user_watchlists
    WHERE owner_user_id = 'p.upgradehandle') = 'p.upgradehandle';

  -- The lease taken before the migration is still the one that finishes.
  ASSERT public.finish_watchlist_prewarm('ur7200001', 600,
    '74444444-4444-4444-8444-444444444444', 1) IS NULL;
  RESET ROLE;
END;
$$;

DELETE FROM public.accounts WHERE legacy_imdb_user_id IN
  ('ur7200001', 'p.upgradehandle', 'ls7200002', 'ur72abc00x9', '  junk / id  ');

COMMIT;
