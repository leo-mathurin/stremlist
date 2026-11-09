-- The v1 backend (main before v2.0.0) keeps serving production between
-- `supabase db push` and the promotion of v2, and old staging and preview
-- deployments use the same database. This test runs the reads, writes and
-- RPCs of that backend, as PostgREST sends them (role service_role), on the
-- migrated schema. Run with psql -v ON_ERROR_STOP=1 against a migrated local
-- database.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  user_row record;
  list_id uuid;
  result record;
  generation bigint;
  lease uuid := gen_random_uuid();
  other_lease uuid := gen_random_uuid();
BEGIN
  -- ensureUser: upsert on the IMDb user ID, then read the full row.
  INSERT INTO public.users AS u (imdb_user_id, is_active, last_fetched_at)
  VALUES ('ur7100001', true, now())
  ON CONFLICT (imdb_user_id) DO UPDATE SET
    imdb_user_id = EXCLUDED.imdb_user_id,
    is_active = EXCLUDED.is_active,
    last_fetched_at = EXCLUDED.last_fetched_at
  RETURNING * INTO user_row;
  ASSERT user_row.imdb_user_id = 'ur7100001';
  ASSERT user_row.prewarm_request_generation = 0;
  ASSERT (SELECT id FROM public.accounts WHERE legacy_imdb_user_id = 'ur7100001')
    ~ '^sl_[0-9A-Za-z]{22}$', 'A v1 user gets a generated Account ID';

  -- The same upsert again keeps one Account.
  INSERT INTO public.users AS u (imdb_user_id, is_active, last_fetched_at)
  VALUES ('ur7100001', true, now())
  ON CONFLICT (imdb_user_id) DO UPDATE SET
    imdb_user_id = EXCLUDED.imdb_user_id,
    is_active = EXCLUDED.is_active,
    last_fetched_at = EXCLUDED.last_fetched_at;
  ASSERT (SELECT count(*) FROM public.accounts
    WHERE legacy_imdb_user_id = 'ur7100001') = 1;

  -- Legacy IDs that are not ur + digits stay usable.
  INSERT INTO public.users (imdb_user_id, is_active, last_fetched_at)
  VALUES ('p.abcdef12345', true, now()), ('ls123456789', true, now());
  ASSERT (SELECT count(*) FROM public.users
    WHERE imdb_user_id IN ('p.abcdef12345', 'ls123456789')) = 2;

  -- seedDefaultWatchlist: check, then insert the default List.
  ASSERT NOT EXISTS (SELECT id FROM public.user_watchlists
    WHERE owner_user_id = 'ur7100001' LIMIT 1);
  INSERT INTO public.user_watchlists (
    owner_user_id, imdb_user_id, catalog_title, sort_option, position
  ) VALUES ('ur7100001', 'ur7100001', '', 'added_at-asc', 0);
  SELECT * INTO result FROM public.user_watchlists
  WHERE owner_user_id = 'ur7100001';
  ASSERT result.imdb_user_id = 'ur7100001';
  ASSERT result.display_mode = 'split';
  ASSERT result.catalog_settings = '{}'::jsonb;
  list_id := result.id;
  ASSERT (SELECT provider FROM public.lists WHERE id = list_id) = 'imdb',
    'A v1 List is an IMDb List';

  -- The unique (owner, IMDb ID) rule still holds.
  BEGIN
    INSERT INTO public.user_watchlists (
      owner_user_id, imdb_user_id, catalog_title, sort_option, position
    ) VALUES ('ur7100001', 'ur7100001', '', 'added_at-asc', 1);
    RAISE EXCEPTION 'Expected unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- getUserWatchlists and getUserWatchlistById.
  ASSERT (SELECT count(*) FROM public.user_watchlists
    WHERE owner_user_id = 'ur7100001') = 1;
  ASSERT EXISTS (SELECT 1 FROM public.user_watchlists
    WHERE owner_user_id = 'ur7100001' AND id = list_id);

  -- replace_user_config: keep, change and add Lists, and set the RPDB key.
  SELECT * INTO result FROM public.replace_user_config('ur7100001', 'rpdb-key',
    jsonb_build_array(
      jsonb_build_object('id', list_id, 'imdb_user_id', 'ls100000002',
        'catalog_title', 'Renamed', 'sort_option', 'title-asc',
        'display_mode', 'movie', 'position', 1,
        'catalog_settings', '{"minRating":6}'::jsonb),
      jsonb_build_object('imdb_user_id', 'ur7100001', 'catalog_title', 'New',
        'sort_option', 'added_at-desc', 'display_mode', 'split',
        'position', 0)));
  ASSERT result.deleted_ids = '{}'::uuid[];
  ASSERT jsonb_array_length(result.watchlists) = 2;
  ASSERT result.watchlists->0->>'catalog_title' = 'New';
  ASSERT result.watchlists->0->>'owner_user_id' = 'ur7100001';
  ASSERT result.watchlists->1->>'id' = list_id::text;
  ASSERT result.watchlists->1->>'imdb_user_id' = 'ls100000002';
  ASSERT result.watchlists->1->'catalog_settings' = '{"minRating":6}'::jsonb;
  -- The rows have the v1 shape that mapWatchlistRow reads.
  ASSERT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(result.watchlists->0) k)
    = ARRAY['catalog_settings', 'catalog_title', 'created_at', 'display_mode',
      'id', 'imdb_user_id', 'owner_user_id', 'position', 'sort_option',
      'updated_at'];
  ASSERT (SELECT rpdb_api_key FROM public.users WHERE imdb_user_id = 'ur7100001')
    = 'rpdb-key';

  -- Omitted settings keep the saved ones; a removed List is reported.
  SELECT * INTO result FROM public.replace_user_config('ur7100001', NULL,
    jsonb_build_array(jsonb_build_object('id', list_id,
      'imdb_user_id', 'ls100000002', 'catalog_title', 'Renamed',
      'sort_option', 'title-asc', 'display_mode', 'movie', 'position', 0)));
  ASSERT cardinality(result.deleted_ids) = 1;
  ASSERT jsonb_array_length(result.watchlists) = 1;
  ASSERT result.watchlists->0->'catalog_settings' = '{"minRating":6}'::jsonb;

  -- A List of another user is refused.
  BEGIN
    PERFORM public.replace_user_config('ls123456789', NULL,
      jsonb_build_array(jsonb_build_object('id', list_id,
        'imdb_user_id', 'ur1', 'catalog_title', '', 'sort_option', 'title-asc',
        'display_mode', 'split', 'position', 0)));
    RAISE EXCEPTION 'Expected ownership rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Watchlist does not belong to this user' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.replace_user_config('ur7199999', NULL, '[]');
    RAISE EXCEPTION 'Expected missing user';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'User not found' THEN RAISE; END IF;
  END;

  -- A Provider List of the Account (v2) is not shown to v1 and v1 saves
  -- do not delete it.
  INSERT INTO public.lists (account_id, provider, source_ref, catalog_title,
    sort_option, display_mode, position)
  SELECT id, 'trakt', 'users/leo/watchlist', 'Trakt', 'title-asc', 'split', 5
  FROM public.accounts WHERE legacy_imdb_user_id = 'ur7100001';
  ASSERT (SELECT count(*) FROM public.user_watchlists
    WHERE owner_user_id = 'ur7100001') = 1;
  SELECT * INTO result FROM public.replace_user_config('ur7100001', NULL,
    jsonb_build_array(jsonb_build_object('id', list_id,
      'imdb_user_id', 'ls100000002', 'catalog_title', 'Renamed',
      'sort_option', 'title-asc', 'display_mode', 'movie', 'position', 0)));
  ASSERT result.deleted_ids = '{}'::uuid[];
  ASSERT EXISTS (SELECT 1 FROM public.lists WHERE provider = 'trakt'
    AND source_ref = 'users/leo/watchlist');

  -- Catalog requests update the activity timestamps.
  UPDATE public.users SET last_fetched_at = '2026-01-01T00:00:00Z'
  WHERE imdb_user_id = 'ur7100001';
  UPDATE public.users SET last_cache_served_at = '2026-01-02T00:00:00Z'
  WHERE imdb_user_id = 'ur7100001';
  ASSERT (SELECT last_fetched_at FROM public.accounts
    WHERE legacy_imdb_user_id = 'ur7100001') = '2026-01-01T00:00:00Z';
  ASSERT (SELECT last_cache_served_at FROM public.accounts
    WHERE legacy_imdb_user_id = 'ur7100001') = '2026-01-02T00:00:00Z';

  -- /stats and /health.
  ASSERT (SELECT count(*) FROM public.users WHERE is_active) >= 3;
  PERFORM count(imdb_user_id) FROM public.users;

  -- Prewarm leases: claim, refuse a second claim, finish.
  generation := public.request_watchlist_prewarm('ur7100001', 60, lease);
  ASSERT generation = 1;
  ASSERT public.request_watchlist_prewarm('ur7100001', 60, other_lease) IS NULL,
    'A second claim waits for the lease';
  ASSERT public.finish_watchlist_prewarm('ur7100001', 60, lease, 1) = 2,
    'The waiting request is reported';
  ASSERT public.finish_watchlist_prewarm('ur7100001', 60, lease, 2) IS NULL;
  ASSERT public.request_watchlist_prewarm('ur7199999', 60, lease) IS NULL;

  -- cleanup-invalid-users: delete a user and its Lists.
  DELETE FROM public.users WHERE imdb_user_id IN ('ur7100001');
  ASSERT NOT EXISTS (SELECT 1 FROM public.accounts
    WHERE legacy_imdb_user_id = 'ur7100001');
  ASSERT NOT EXISTS (SELECT 1 FROM public.lists WHERE id = list_id);
END;
$$;

-- Accounts without a Legacy alias are not v1 users.
DO $$
BEGIN
  INSERT INTO public.accounts (is_active) VALUES (true);
  ASSERT NOT EXISTS (SELECT 1 FROM public.users WHERE imdb_user_id IS NULL);
END;
$$;

RESET ROLE;

-- Clients without the service role cannot read through the views.
DO $$
BEGIN
  ASSERT NOT has_table_privilege('anon', 'public.users', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'public.user_watchlists', 'SELECT');
  ASSERT NOT has_function_privilege('anon',
    'public.replace_user_config(text, text, jsonb)', 'EXECUTE');
END;
$$;

ROLLBACK;
