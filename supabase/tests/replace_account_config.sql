-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id, legacy_imdb_user_id, rpdb_api_key)
VALUES ('sl_configtransactiontest00', NULL, 'old-key'),
  ('sl_configothertest00000000', 'ur4', NULL);
INSERT INTO public.lists (
  id, account_id, provider, source_ref, catalog_title, position, catalog_settings
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'sl_configtransactiontest00', 'imdb', 'ur1', 'One', 0, '{"minRating":8}'),
  ('22222222-2222-4222-8222-222222222222', 'sl_configtransactiontest00', 'trakt', 'users/leo/watchlist', 'Two', 1, '{"minRating":5}'),
  ('33333333-3333-4333-8333-333333333333', 'sl_configtransactiontest00', 'imdb', 'ur3', 'Removed', 2, '{}'),
  ('44444444-4444-4444-8444-444444444444', 'sl_configothertest00000000', 'imdb', 'ur4', 'Other account', 0, '{}');

DO $$
DECLARE
  payload jsonb := '[
    {"id":"11111111-1111-4111-8111-111111111111","provider":"imdb","source_ref":"ur1","catalog_title":"Changed","sort_option":"title-asc","display_mode":"split","position":0},
    {"id":"22222222-2222-4222-8222-222222222222","provider":"trakt","source_ref":"users/leo/watchlist","catalog_title":"Two","sort_option":"title-desc","display_mode":"split","position":1,"catalog_settings":{}}
  ]';
  before_rows jsonb;
  result record;
BEGIN
  SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO before_rows FROM public.lists l;

  -- The second write fails after the deletion and first update have executed.
  BEGIN
    PERFORM public.replace_account_config('sl_configtransactiontest00', 'new-key',
      jsonb_set(jsonb_set(payload, '{1,source_ref}', '"ur1"'), '{1,provider}', '"imdb"'), NULL, NULL);
    RAISE EXCEPTION 'Expected unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.lists l) = before_rows,
    'A failed write must roll back deletions and earlier updates';
  ASSERT (SELECT rpdb_api_key FROM public.accounts WHERE id = 'sl_configtransactiontest00') = 'old-key';

  -- The same source on two different Providers is allowed.
  -- Failure in the final accounts update must roll back the lists too.
  ALTER TABLE public.accounts ADD CONSTRAINT config_test_key CHECK (rpdb_api_key IS DISTINCT FROM 'reject-key');
  BEGIN
    PERFORM public.replace_account_config('sl_configtransactiontest00', 'reject-key', payload, NULL, NULL);
    RAISE EXCEPTION 'Expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.lists l) = before_rows;
  ALTER TABLE public.accounts DROP CONSTRAINT config_test_key;

  BEGIN
    PERFORM public.replace_account_config('sl_configtransactiontest00', NULL,
      jsonb_set(payload, '{0,id}', '"44444444-4444-4444-8444-444444444444"'), NULL, NULL);
    RAISE EXCEPTION 'Expected ownership rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'List does not belong to this account' THEN RAISE; END IF;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.lists l) = before_rows;

  BEGIN
    PERFORM public.replace_account_config('sl_configtransactiontest00', NULL,
      jsonb_set(payload, '{1,id}', payload->0->'id'), NULL, NULL);
    RAISE EXCEPTION 'Expected duplicate ID rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Duplicate list ID' THEN RAISE; END IF;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.lists l) = before_rows;

  SELECT * INTO result FROM public.replace_account_config('sl_configtransactiontest00', 'new-key', payload, true, ARRAY['trakt', 'simkl']);
  ASSERT result.deleted_ids = ARRAY['33333333-3333-4333-8333-333333333333'::uuid];
  ASSERT jsonb_array_length(result.lists) = 2;
  ASSERT result.lists->0->>'id' = payload->0->>'id', 'Updates must preserve IDs';
  ASSERT result.lists->1->>'id' = payload->1->>'id';
  ASSERT result.lists->1->>'provider' = 'trakt';
  ASSERT result.lists->0->>'catalog_title' = 'Changed';
  ASSERT result.lists->0->>'sort_option' = 'title-asc';
  ASSERT result.lists->0->'catalog_settings' = '{"minRating":8}'::jsonb, 'Omitted settings must survive';
  ASSERT result.lists->1->'catalog_settings' = '{}'::jsonb, 'Explicit empty settings must clear';
  ASSERT (SELECT rpdb_api_key FROM public.accounts WHERE id = 'sl_configtransactiontest00') = 'new-key';
  ASSERT (SELECT actions_enabled FROM public.accounts WHERE id = 'sl_configtransactiontest00');
  ASSERT (SELECT action_providers FROM public.accounts WHERE id = 'sl_configtransactiontest00') = ARRAY['trakt', 'simkl'];

  -- NULL action settings keep the stored values.
  SELECT * INTO result FROM public.replace_account_config('sl_configtransactiontest00', NULL,
    '[{"provider":"imdb","source_ref":"ur1","catalog_title":"New","sort_option":"title-asc","display_mode":"split","position":0}]', NULL, NULL);
  ASSERT cardinality(result.deleted_ids) = 2;
  ASSERT result.lists->0->'catalog_settings' = '{}'::jsonb;
  ASSERT result.lists->0->>'id' IS NOT NULL;
  ASSERT (SELECT rpdb_api_key FROM public.accounts WHERE id = 'sl_configtransactiontest00') IS NULL;
  ASSERT (SELECT actions_enabled FROM public.accounts WHERE id = 'sl_configtransactiontest00');

  ASSERT public.generate_account_id() ~ '^sl_[0-9A-Za-z]{22}$';

  ASSERT NOT has_function_privilege('anon', 'public.replace_account_config(text,text,jsonb,boolean,text[])', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.replace_account_config(text,text,jsonb,boolean,text[])', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.replace_account_config(text,text,jsonb,boolean,text[])', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.claim_connection_refresh(text,text,integer,uuid)', 'EXECUTE');
END;
$$;

-- Merged Lists keep their other Source lists (STR-59).
DO $$
DECLARE
  merged jsonb := '[{"provider":"trakt","source_ref":"users/leo/watchlist"}]';
  result record;
  list_id text;
BEGIN
  SELECT * INTO result FROM public.replace_account_config('sl_configtransactiontest00', NULL,
    jsonb_build_array(jsonb_build_object('provider', 'imdb', 'source_ref', 'ur7',
      'catalog_title', 'Merged', 'sort_option', 'title-asc', 'display_mode', 'split',
      'position', 0, 'merged_sources', merged)), NULL, NULL);
  ASSERT result.lists->0->'merged_sources' = merged, 'Inserts must store merged Source lists';
  list_id := result.lists->0->>'id';

  SELECT * INTO result FROM public.replace_account_config('sl_configtransactiontest00', NULL,
    jsonb_build_array(jsonb_build_object('id', list_id, 'provider', 'imdb', 'source_ref', 'ur7',
      'catalog_title', 'Renamed', 'sort_option', 'title-asc', 'display_mode', 'split',
      'position', 0)), NULL, NULL);
  ASSERT result.lists->0->'merged_sources' = merged, 'Omitted merged Source lists must survive';

  SELECT * INTO result FROM public.replace_account_config('sl_configtransactiontest00', NULL,
    jsonb_build_array(jsonb_build_object('id', list_id, 'provider', 'imdb', 'source_ref', 'ur7',
      'catalog_title', 'Split', 'sort_option', 'title-asc', 'display_mode', 'split',
      'position', 0, 'merged_sources', '[]'::jsonb)), NULL, NULL);
  ASSERT result.lists->0->'merged_sources' = '[]'::jsonb, 'An explicit empty array must split the List';

  BEGIN
    PERFORM public.replace_account_config('sl_configtransactiontest00', NULL,
      jsonb_build_array(jsonb_build_object('id', list_id, 'provider', 'imdb', 'source_ref', 'ur7',
        'catalog_title', 'Bad', 'sort_option', 'title-asc', 'display_mode', 'split',
        'position', 0, 'merged_sources', '{}'::jsonb)), NULL, NULL);
    RAISE EXCEPTION 'Expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Connection refresh lease: only one holder at a time.
INSERT INTO public.connections (account_id, provider, access_token, redirect_uri)
VALUES (
  'sl_configtransactiontest00', 'trakt', 'enc',
  'http://127.0.0.1:7001/oauth/trakt/callback'
);
DO $$
BEGIN
  ASSERT public.claim_connection_refresh('sl_configtransactiontest00', 'trakt', 30, '55555555-5555-4555-8555-555555555555');
  ASSERT NOT public.claim_connection_refresh('sl_configtransactiontest00', 'trakt', 30, '66666666-6666-4666-8666-666666666666');
  ASSERT NOT public.release_connection_refresh('sl_configtransactiontest00', 'trakt', '66666666-6666-4666-8666-666666666666');
  ASSERT public.release_connection_refresh('sl_configtransactiontest00', 'trakt', '55555555-5555-4555-8555-555555555555');
  ASSERT public.claim_connection_refresh('sl_configtransactiontest00', 'trakt', 30, '66666666-6666-4666-8666-666666666666');
END;
$$;

ROLLBACK;
