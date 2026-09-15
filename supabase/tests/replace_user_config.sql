-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.users (imdb_user_id, rpdb_api_key)
VALUES ('config-transaction-test', 'old-key'), ('config-other-test', NULL);
INSERT INTO public.user_watchlists (
  id, owner_user_id, imdb_user_id, catalog_title, position, catalog_settings
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'config-transaction-test', 'ur1', 'One', 0, '{"minRating":8}'),
  ('22222222-2222-4222-8222-222222222222', 'config-transaction-test', 'ur2', 'Two', 1, '{"minRating":5}'),
  ('33333333-3333-4333-8333-333333333333', 'config-transaction-test', 'ur3', 'Removed', 2, '{}'),
  ('44444444-4444-4444-8444-444444444444', 'config-other-test', 'ur4', 'Other user', 0, '{}');

DO $$
DECLARE
  payload jsonb := '[
    {"id":"11111111-1111-4111-8111-111111111111","imdb_user_id":"ur1","catalog_title":"Changed","sort_option":"title-asc","display_mode":"split","position":0},
    {"id":"22222222-2222-4222-8222-222222222222","imdb_user_id":"ur2","catalog_title":"Two","sort_option":"title-desc","display_mode":"split","position":1,"catalog_settings":{}}
  ]';
  before_rows jsonb;
  result record;
BEGIN
  SELECT jsonb_agg(to_jsonb(uw) ORDER BY id) INTO before_rows FROM public.user_watchlists uw;

  -- The second write fails after the deletion and first update have executed.
  BEGIN
    PERFORM public.replace_user_config('config-transaction-test', 'new-key',
      jsonb_set(payload, '{1,imdb_user_id}', '"ur1"'));
    RAISE EXCEPTION 'Expected unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(uw) ORDER BY id) FROM public.user_watchlists uw) = before_rows,
    'A failed write must roll back deletions and earlier updates';
  ASSERT (SELECT rpdb_api_key FROM public.users WHERE imdb_user_id = 'config-transaction-test') = 'old-key';

  -- Failure in the final users update must roll back the watchlists too.
  ALTER TABLE public.users ADD CONSTRAINT config_test_key CHECK (rpdb_api_key IS DISTINCT FROM 'reject-key');
  BEGIN
    PERFORM public.replace_user_config('config-transaction-test', 'reject-key', payload);
    RAISE EXCEPTION 'Expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(uw) ORDER BY id) FROM public.user_watchlists uw) = before_rows;
  ALTER TABLE public.users DROP CONSTRAINT config_test_key;

  BEGIN
    PERFORM public.replace_user_config('config-transaction-test', NULL,
      jsonb_set(payload, '{0,id}', '"44444444-4444-4444-8444-444444444444"'));
    RAISE EXCEPTION 'Expected ownership rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Watchlist does not belong to this user' THEN RAISE; END IF;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(uw) ORDER BY id) FROM public.user_watchlists uw) = before_rows;

  BEGIN
    PERFORM public.replace_user_config('config-transaction-test', NULL,
      jsonb_set(payload, '{1,id}', payload->0->'id'));
    RAISE EXCEPTION 'Expected duplicate ID rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Duplicate watchlist ID' THEN RAISE; END IF;
  END;
  ASSERT (SELECT jsonb_agg(to_jsonb(uw) ORDER BY id) FROM public.user_watchlists uw) = before_rows;

  SELECT * INTO result FROM public.replace_user_config('config-transaction-test', 'new-key', payload);
  ASSERT result.deleted_ids = ARRAY['33333333-3333-4333-8333-333333333333'::uuid];
  ASSERT jsonb_array_length(result.watchlists) = 2;
  ASSERT result.watchlists->0->>'id' = payload->0->>'id', 'Updates must preserve IDs';
  ASSERT result.watchlists->1->>'id' = payload->1->>'id';
  ASSERT result.watchlists->0->>'catalog_title' = 'Changed';
  ASSERT result.watchlists->0->>'sort_option' = 'title-asc';
  ASSERT result.watchlists->0->'catalog_settings' = '{"minRating":8}'::jsonb, 'Omitted settings must survive';
  ASSERT result.watchlists->1->'catalog_settings' = '{}'::jsonb, 'Explicit empty settings must clear';
  ASSERT (SELECT rpdb_api_key FROM public.users WHERE imdb_user_id = 'config-transaction-test') = 'new-key';

  SELECT * INTO result FROM public.replace_user_config('config-transaction-test', NULL,
    '[{"imdb_user_id":"ur1","catalog_title":"New","sort_option":"title-asc","display_mode":"split","position":0}]');
  ASSERT cardinality(result.deleted_ids) = 2;
  ASSERT result.watchlists->0->'catalog_settings' = '{}'::jsonb;
  ASSERT result.watchlists->0->>'id' IS NOT NULL;
  ASSERT (SELECT rpdb_api_key FROM public.users WHERE imdb_user_id = 'config-transaction-test') IS NULL;

  ASSERT NOT has_function_privilege('anon', 'public.replace_user_config(text,text,jsonb)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.replace_user_config(text,text,jsonb)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.replace_user_config(text,text,jsonb)', 'EXECUTE');
END;
$$;

ROLLBACK;
