-- Poster source: each Account chooses where its posters come from: IMDb (the
-- default, the posters that Stremlist always showed), TMDB, or RPDB with the
-- Account's RPDB key. The key stays saved when another source is chosen. The
-- choice is saved with the rest of the configuration by
-- `replace_account_config`, so a save never mixes two requests.
--
-- `tmdb_posters` caches the TMDB poster of each Title for every Account: the
-- poster of a Title does not depend on who asks, only the choice to show it
-- does.

ALTER TABLE public.accounts
  ADD COLUMN poster_source text NOT NULL DEFAULT 'imdb'
  CONSTRAINT accounts_poster_source_check
    CHECK (poster_source IN ('imdb', 'tmdb', 'rpdb'));

-- Before this change, an RPDB key alone turned RPDB posters on: those
-- Accounts keep them.
UPDATE public.accounts
SET poster_source = 'rpdb'
WHERE nullif(btrim(rpdb_api_key), '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tmdb_posters: the TMDB poster of each Title (IMDb ID)
-- ---------------------------------------------------------------------------

CREATE TABLE public.tmdb_posters (
  imdb_id text PRIMARY KEY,
  -- The TMDB image path (`/abc.jpg`). NULL: TMDB has no poster for the Title.
  -- Such rows are checked again later; a failed TMDB request writes no row.
  poster_path text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tmdb_posters ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- replace_account_config and create_account_with_config
-- ---------------------------------------------------------------------------

DROP FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean);

-- Same as 20261008120000_atomic_account_writes.sql, with the poster source.
CREATE FUNCTION public.replace_account_config(
  p_account_id text,
  p_rpdb_api_key text,
  p_lists jsonb,
  p_actions_enabled boolean,
  p_action_providers text[],
  -- NULL keeps the current value, like the Actions settings.
  p_new_titles_catalog boolean DEFAULT NULL,
  -- NULL keeps the current value: an older client does not send it.
  p_poster_source text DEFAULT NULL
)
RETURNS TABLE (previous_lists jsonb, lists jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
BEGIN
  -- Serialize replacements, including requests that only create new rows.
  PERFORM 1 FROM public.accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF jsonb_typeof(p_lists) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Lists must be an array';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
    WHERE value ? 'id' AND NOT EXISTS (
      SELECT 1 FROM public.lists l
      WHERE l.id = (value->>'id')::uuid AND l.account_id = p_account_id
    )
  ) THEN
    RAISE EXCEPTION 'List does not belong to this account';
  END IF;

  IF EXISTS (
    SELECT value->>'id' FROM jsonb_array_elements(p_lists) AS entries(value)
    WHERE value ? 'id' GROUP BY value->>'id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate list ID';
  END IF;

  -- The API checked the merge rules against these saved Source lists when the
  -- client omitted them. A save in between (accounts row lock above) may
  -- have changed them: refuse instead of writing a stale or unchecked set.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
    JOIN public.lists l ON l.id = (value->>'id')::uuid
    WHERE value ? 'expected_merged_sources'
      AND l.merged_sources IS DISTINCT FROM value->'expected_merged_sources'
  ) THEN
    RAISE EXCEPTION 'Merged Source lists changed';
  END IF;

  -- The Lists before this save, read under the lock: a concurrent save
  -- cannot change them before this one ends.
  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO previous_lists FROM public.lists l
  WHERE l.account_id = p_account_id;

  DELETE FROM public.lists l
  WHERE l.account_id = p_account_id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
      WHERE (value->>'id')::uuid = l.id
    );

  FOR item IN SELECT value FROM jsonb_array_elements(p_lists)
  LOOP
    INSERT INTO public.lists AS l (
      id, account_id, provider, source_ref, catalog_title, sort_option,
      display_mode, position, catalog_settings, merged_sources, source_label
    ) VALUES (
      coalesce((item->>'id')::uuid, gen_random_uuid()),
      p_account_id, item->>'provider', item->>'source_ref',
      item->>'catalog_title', item->>'sort_option', item->>'display_mode',
      (item->>'position')::integer, coalesce(item->'catalog_settings', '{}'::jsonb),
      coalesce(item->'merged_sources', '[]'::jsonb), item->>'source_label'
    )
    ON CONFLICT (id) DO UPDATE SET
      provider = EXCLUDED.provider,
      source_ref = EXCLUDED.source_ref,
      catalog_title = EXCLUDED.catalog_title,
      sort_option = EXCLUDED.sort_option,
      display_mode = EXCLUDED.display_mode,
      position = EXCLUDED.position,
      -- Omitted settings preserve the locked row, not a client-side snapshot.
      catalog_settings = CASE WHEN item ? 'catalog_settings'
        THEN EXCLUDED.catalog_settings ELSE l.catalog_settings END,
      -- Same for merged Source lists: an older client that does not know
      -- them must not split a merged List.
      merged_sources = CASE WHEN item ? 'merged_sources'
        THEN EXCLUDED.merged_sources ELSE l.merged_sources END,
      source_label = CASE WHEN item ? 'source_label'
        THEN EXCLUDED.source_label ELSE l.source_label END,
      updated_at = now()
    WHERE l.account_id = p_account_id;
  END LOOP;

  UPDATE public.accounts
  SET rpdb_api_key = p_rpdb_api_key,
    actions_enabled = coalesce(p_actions_enabled, actions_enabled),
    action_providers = coalesce(p_action_providers, action_providers),
    new_titles_catalog = coalesce(p_new_titles_catalog, new_titles_catalog),
    poster_source = coalesce(p_poster_source, poster_source)
  WHERE id = p_account_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO lists FROM public.lists l
  WHERE l.account_id = p_account_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean, text)
TO service_role;

DROP FUNCTION public.create_account_with_config(text, jsonb, boolean);

CREATE FUNCTION public.create_account_with_config(
  p_rpdb_api_key text,
  p_lists jsonb,
  p_new_titles_catalog boolean DEFAULT NULL,
  p_poster_source text DEFAULT NULL
)
RETURNS TABLE (account_id text, lists jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  new_id text;
BEGIN
  INSERT INTO public.accounts (is_active) VALUES (true)
  RETURNING id INTO new_id;

  RETURN QUERY
  SELECT new_id, saved.lists
  FROM public.replace_account_config(
    new_id, p_rpdb_api_key, p_lists, NULL, NULL, p_new_titles_catalog,
    p_poster_source
  ) AS saved;
END;
$$;

REVOKE ALL ON FUNCTION public.create_account_with_config(text, jsonb, boolean, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_account_with_config(text, jsonb, boolean, text)
TO service_role;
