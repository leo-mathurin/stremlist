-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id, legacy_imdb_user_id, rpdb_api_key, new_titles_catalog)
VALUES
  ('sl_writeslegacy00000000000', 'ur7000001', 'legacy-key', true),
  ('sl_writesprivate0000000000', NULL, NULL, false);
INSERT INTO public.lists (
  id, account_id, provider, source_ref, catalog_title, sort_option,
  display_mode, position, catalog_settings, merged_sources, source_label
) VALUES
  ('71111111-1111-4111-8111-111111111111', 'sl_writeslegacy00000000000',
    'imdb', 'ur7000001', 'Second', 'title-asc', 'movie', 5, '{"minRating":7}',
    '[{"provider":"trakt","source_ref":"users/leo/watchlist","label":"Leo"}]',
    'Mine'),
  ('72222222-2222-4222-8222-222222222222', 'sl_writeslegacy00000000000',
    'imdb', 'ls100000001', 'First', 'added_at-desc', 'split', 2, '{}', '[]',
    NULL);

-- A new Account gets its first configuration in the same transaction.
DO $$
DECLARE
  accounts_before bigint;
  result record;
BEGIN
  SELECT count(*) INTO accounts_before FROM public.accounts;

  SELECT * INTO result FROM public.create_account_with_config('new-key',
    '[{"provider":"imdb","source_ref":"ur7000002","catalog_title":"","sort_option":"title-asc","display_mode":"split","position":0}]',
    true);
  ASSERT result.account_id ~ '^sl_[0-9A-Za-z]{22}$', 'A generated Account ID';
  ASSERT jsonb_array_length(result.lists) = 1;
  ASSERT result.lists->0->>'account_id' = result.account_id;
  ASSERT (SELECT rpdb_api_key FROM public.accounts WHERE id = result.account_id) = 'new-key';
  ASSERT (SELECT new_titles_catalog FROM public.accounts WHERE id = result.account_id);
  ASSERT NOT (SELECT actions_enabled FROM public.accounts WHERE id = result.account_id);

  -- No Lists is allowed: Simkl and MDBList users connect first.
  SELECT * INTO result FROM public.create_account_with_config(NULL, '[]', NULL);
  ASSERT result.lists = '[]'::jsonb;
  ASSERT NOT (SELECT new_titles_catalog FROM public.accounts WHERE id = result.account_id);
  ASSERT (SELECT count(*) FROM public.accounts) = accounts_before + 2;

  -- A configuration that cannot be saved leaves no Account behind.
  BEGIN
    PERFORM public.create_account_with_config(NULL,
      '[{"provider":"imdb","source_ref":"ur7000003","catalog_title":"","sort_option":"title-asc","display_mode":"split","position":0},
        {"provider":"imdb","source_ref":"ur7000003","catalog_title":"","sort_option":"title-asc","display_mode":"split","position":1}]',
      NULL);
    RAISE EXCEPTION 'Expected unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM public.accounts) = accounts_before + 2,
    'A failed configuration must not leave an orphan Account';
  BEGIN
    PERFORM public.create_account_with_config(NULL, '{}', NULL);
    RAISE EXCEPTION 'Expected array rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Lists must be an array' THEN RAISE; END IF;
  END;
  ASSERT (SELECT count(*) FROM public.accounts) = accounts_before + 2;

  ASSERT NOT has_function_privilege('anon', 'public.create_account_with_config(text,jsonb,boolean)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.create_account_with_config(text,jsonb,boolean)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.create_account_with_config(text,jsonb,boolean)', 'EXECUTE');
END;
$$;

-- A Legacy alias install gets a private copy and is marked as moved, at once.
DO $$
DECLARE
  legacy_id constant text := 'sl_writeslegacy00000000000';
  legacy_lists jsonb;
  accounts_before bigint;
  private_copy public.accounts;
  copied jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) INTO legacy_lists
  FROM public.lists l WHERE l.account_id = legacy_id;

  -- A copy that fails half way leaves no Account and no moved mark.
  SELECT count(*) INTO accounts_before FROM public.accounts;
  ALTER TABLE public.lists ADD CONSTRAINT copy_test_reject
    CHECK (catalog_title <> 'Second' OR account_id = 'sl_writeslegacy00000000000');
  BEGIN
    PERFORM public.copy_legacy_account(legacy_id);
    RAISE EXCEPTION 'Expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ALTER TABLE public.lists DROP CONSTRAINT copy_test_reject;
  ASSERT (SELECT count(*) FROM public.accounts) = accounts_before,
    'A failed copy must not leave an orphan Account';
  ASSERT (SELECT moved_at FROM public.accounts WHERE id = legacy_id) IS NULL,
    'A failed copy must not mark the Legacy alias as moved';

  private_copy := public.copy_legacy_account(legacy_id);
  ASSERT private_copy.id <> legacy_id;
  ASSERT private_copy.legacy_imdb_user_id IS NULL;
  ASSERT private_copy.rpdb_api_key = 'legacy-key';
  ASSERT private_copy.new_titles_catalog;
  ASSERT NOT private_copy.actions_enabled;
  ASSERT private_copy.moved_at IS NULL;
  ASSERT (SELECT moved_at FROM public.accounts WHERE id = legacy_id) IS NOT NULL,
    'The Legacy alias is marked as moved in the same transaction';

  SELECT jsonb_agg(jsonb_build_object(
      'provider', l.provider, 'source_ref', l.source_ref,
      'catalog_title', l.catalog_title, 'sort_option', l.sort_option,
      'display_mode', l.display_mode, 'position', l.position,
      'catalog_settings', l.catalog_settings,
      'merged_sources', l.merged_sources, 'source_label', l.source_label)
    ORDER BY l.position)
  INTO copied FROM public.lists l WHERE l.account_id = private_copy.id;
  ASSERT copied = '[
    {"provider":"imdb","source_ref":"ls100000001","catalog_title":"First","sort_option":"added_at-desc","display_mode":"split","position":0,"catalog_settings":{},"merged_sources":[],"source_label":null},
    {"provider":"imdb","source_ref":"ur7000001","catalog_title":"Second","sort_option":"title-asc","display_mode":"movie","position":1,"catalog_settings":{"minRating":7},"merged_sources":[{"provider":"trakt","source_ref":"users/leo/watchlist","label":"Leo"}],"source_label":"Mine"}
  ]'::jsonb, format('The copy keeps every List in order, got %s', copied);
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.lists l
    WHERE l.account_id = private_copy.id
      AND l.id IN ('71111111-1111-4111-8111-111111111111', '72222222-2222-4222-8222-222222222222')
  ), 'The copied Lists get their own IDs';
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.lists l
    WHERE l.account_id = legacy_id) = legacy_lists,
    'The Legacy Account keeps its Lists';

  BEGIN
    PERFORM public.copy_legacy_account('sl_writesprivate0000000000');
    RAISE EXCEPTION 'Expected Legacy alias rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Legacy account not found' THEN RAISE; END IF;
  END;

  ASSERT NOT has_function_privilege('anon', 'public.copy_legacy_account(text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.copy_legacy_account(text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.copy_legacy_account(text)', 'EXECUTE');
END;
$$;

-- Connections are saved and deleted with the history and statuses they own.
INSERT INTO public.lists (id, account_id, provider, source_ref, catalog_title, merged_sources)
VALUES
  ('73333333-3333-4333-8333-333333333333', 'sl_writesprivate0000000000',
    'trakt', 'me/watchlist', '',
    '[{"provider":"imdb","source_ref":"ur7000009"}]'),
  ('74444444-4444-4444-8444-444444444444', 'sl_writesprivate0000000000',
    'trakt', 'users/leo/watchlist', '', '[]'),
  ('75555555-5555-4555-8555-555555555555', 'sl_writeslegacy00000000000',
    'trakt', 'me/watchlist', '', '[]');
INSERT INTO public.list_sync_status (list_id, provider, source_ref, last_attempt_at)
VALUES
  ('73333333-3333-4333-8333-333333333333', 'trakt', 'me/watchlist', now()),
  ('73333333-3333-4333-8333-333333333333', 'imdb', 'ur7000009', now()),
  ('74444444-4444-4444-8444-444444444444', 'trakt', 'users/leo/watchlist', now()),
  ('75555555-5555-4555-8555-555555555555', 'trakt', 'me/watchlist', now());
INSERT INTO public.source_list_syncs (
  account_id, provider, source_ref, baseline_at, last_complete_sync_at,
  requires_connection, connection_user
) VALUES
  ('sl_writesprivate0000000000', 'trakt', 'me/watchlist', now(), now(), true, 'leo'),
  ('sl_writesprivate0000000000', 'trakt', 'me/history', now(), now(), true, 'sam'),
  ('sl_writesprivate0000000000', 'trakt', 'users/leo/watchlist', now(), now(), false, NULL),
  ('sl_writesprivate0000000000', 'simkl', 'me/plantowatch', now(), now(), true, 'leo');

DO $$
DECLARE
  acc constant text := 'sl_writesprivate0000000000';
  first_created timestamptz;
  syncs text[];
BEGIN
  -- A new Connection for leo.
  PERFORM public.save_connection(acc, 'trakt', 'leo', 'enc-1', 'refresh-1',
    '2026-10-11T00:00:00Z', 'public', 'https://api.stremlist.test/oauth/trakt/callback');
  SELECT created_at INTO first_created FROM public.connections
  WHERE account_id = acc AND provider = 'trakt';
  SELECT array_agg(provider || ':' || source_ref ORDER BY provider, source_ref) INTO syncs
  FROM public.source_list_syncs WHERE account_id = acc;
  ASSERT syncs = ARRAY['simkl:me/plantowatch', 'trakt:me/watchlist', 'trakt:users/leo/watchlist'],
    format('Only the history of another Provider user goes, got %s', syncs);

  -- A refused Connection renewed by leo again keeps leo's history.
  UPDATE public.connections SET needs_renewal_since = now(),
    refresh_locked_until = '2030-01-01T00:00:00Z'
  WHERE account_id = acc AND provider = 'trakt';
  PERFORM public.save_connection(acc, 'trakt', 'leo', 'enc-2', NULL, NULL, NULL,
    'https://api.stremlist.test/oauth/trakt/callback');
  ASSERT (SELECT row(access_token, refresh_token, expires_at, scope, needs_renewal_since)
    FROM public.connections WHERE account_id = acc AND provider = 'trakt')
    IS NOT DISTINCT FROM row('enc-2'::text, NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz),
    'A new authorization replaces the tokens and the renewal mark';
  ASSERT (SELECT created_at FROM public.connections WHERE account_id = acc AND provider = 'trakt') = first_created;
  ASSERT (SELECT refresh_locked_until FROM public.connections WHERE account_id = acc AND provider = 'trakt')
    = '2030-01-01T00:00:00Z', 'Saving leaves the refresh lease alone';
  ASSERT EXISTS (SELECT 1 FROM public.source_list_syncs
    WHERE account_id = acc AND source_ref = 'me/watchlist');

  -- Another Provider user: the history of leo goes in the same transaction.
  PERFORM public.save_connection(acc, 'trakt', 'sam', 'enc-3', NULL, NULL, NULL,
    'https://api.stremlist.test/oauth/trakt/callback');
  SELECT array_agg(provider || ':' || source_ref ORDER BY provider, source_ref) INTO syncs
  FROM public.source_list_syncs WHERE account_id = acc;
  ASSERT syncs = ARRAY['simkl:me/plantowatch', 'trakt:users/leo/watchlist'],
    format('The history of leo goes when sam connects, got %s', syncs);

  -- A delete that fails half way keeps the Connection and its history.
  CREATE FUNCTION pg_temp.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS
    $f$ BEGIN RAISE EXCEPTION 'status delete refused'; END; $f$;
  CREATE TRIGGER refuse_delete BEFORE DELETE ON public.list_sync_status
    FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_delete();
  INSERT INTO public.source_list_syncs (
    account_id, provider, source_ref, baseline_at, last_complete_sync_at,
    requires_connection, connection_user
  ) VALUES (acc, 'trakt', 'me/history', now(), now(), true, 'sam');
  BEGIN
    PERFORM public.delete_connection(acc, 'trakt',
      ARRAY['73333333-3333-4333-8333-333333333333']::uuid[], ARRAY['me/watchlist']);
    RAISE EXCEPTION 'Expected the status delete to fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'status delete refused' THEN RAISE; END IF;
  END;
  DROP TRIGGER refuse_delete ON public.list_sync_status;
  ASSERT EXISTS (SELECT 1 FROM public.connections WHERE account_id = acc AND provider = 'trakt'),
    'A failed delete keeps the Connection';
  ASSERT EXISTS (SELECT 1 FROM public.source_list_syncs
    WHERE account_id = acc AND source_ref = 'me/history'),
    'A failed delete keeps the history';

  BEGIN
    PERFORM public.delete_connection(acc, 'trakt',
      ARRAY['73333333-3333-4333-8333-333333333333']::uuid[], ARRAY[]::text[]);
    RAISE EXCEPTION 'Expected length rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'List IDs and Source list refs must have the same length' THEN RAISE; END IF;
  END;

  PERFORM public.delete_connection(acc, 'trakt',
    ARRAY['73333333-3333-4333-8333-333333333333', '75555555-5555-4555-8555-555555555555']::uuid[],
    ARRAY['me/watchlist', 'me/watchlist']);
  ASSERT NOT EXISTS (SELECT 1 FROM public.connections WHERE account_id = acc AND provider = 'trakt');
  SELECT array_agg(provider || ':' || source_ref ORDER BY provider, source_ref) INTO syncs
  FROM public.source_list_syncs WHERE account_id = acc;
  ASSERT syncs = ARRAY['simkl:me/plantowatch', 'trakt:users/leo/watchlist'],
    format('Only the Connection-only history of the Provider goes, got %s', syncs);
  SELECT array_agg(list_id || ':' || provider || ':' || source_ref ORDER BY list_id, provider) INTO syncs
  FROM public.list_sync_status;
  ASSERT syncs = ARRAY[
    '73333333-3333-4333-8333-333333333333:imdb:ur7000009',
    '74444444-4444-4444-8444-444444444444:trakt:users/leo/watchlist',
    '75555555-5555-4555-8555-555555555555:trakt:me/watchlist'
  ], format('Only the given statuses of this Account go, got %s', syncs);

  ASSERT NOT has_function_privilege('anon', 'public.save_connection(text,text,text,text,text,timestamptz,text,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.save_connection(text,text,text,text,text,timestamptz,text,text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.save_connection(text,text,text,text,text,timestamptz,text,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.delete_connection(text,text,uuid[],text[])', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.delete_connection(text,text,uuid[],text[])', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.delete_connection(text,text,uuid[],text[])', 'EXECUTE');
END;
$$;

ROLLBACK;
