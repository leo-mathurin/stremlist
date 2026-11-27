-- Metadata language: each Account chooses the language of Title names and
-- plot summaries in Stremio (`en-US` by default, any supported TMDB locale,
-- or `stremio` to let Stremio's own metadata addon handle descriptions).
--
-- `title_translations` caches the TMDB title and plot summary of each Title
-- per language for every Account: a translation does not depend on who asks.

ALTER TABLE public.accounts
  ADD COLUMN metadata_language text NOT NULL DEFAULT 'en-US'
  CONSTRAINT accounts_metadata_language_check
    CHECK (
      metadata_language IN (
        'stremio',
        'en-US',
        'it-IT',
        'fr-FR',
        'es-ES',
        'es-MX',
        'de-DE',
        'pt-BR',
        'pt-PT',
        'nl-NL',
        'pl-PL',
        'ja-JP',
        'ko-KR',
        'tr-TR',
        'sv-SE',
        'da-DK',
        'nb-NO',
        'fi-FI',
        'cs-CZ',
        'ro-RO',
        'hu-HU',
        'el-GR',
        'uk-UA',
        'ar-SA',
        'zh-CN'
      )
    );

-- ---------------------------------------------------------------------------
-- title_translations: localized TMDB title and plot summary per Title
-- ---------------------------------------------------------------------------

CREATE TABLE public.title_translations (
  language text NOT NULL,
  imdb_id text NOT NULL,
  -- NULL when TMDB has no translation for that field in this language.
  -- Rows are checked again later; a failed request writes no row.
  title text,
  description text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (language, imdb_id)
);
ALTER TABLE public.title_translations ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- replace_account_config and create_account_with_config
-- ---------------------------------------------------------------------------

DROP FUNCTION public.create_account_with_config(text, jsonb, boolean, text, jsonb, boolean);
DROP FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean, text, jsonb, boolean);

CREATE FUNCTION public.replace_account_config(
  p_account_id text,
  p_rpdb_api_key text,
  p_lists jsonb,
  p_actions_enabled boolean,
  p_action_providers text[],
  -- NULL keeps the current value, like the Actions settings.
  p_new_titles_catalog boolean DEFAULT NULL,
  -- NULL keeps the current value: an older client does not send it.
  p_poster_source text DEFAULT NULL,
  p_new_titles_settings jsonb DEFAULT NULL,
  -- NULL keeps the current value: an older client does not send it.
  p_catalog_name_prefix boolean DEFAULT NULL,
  -- NULL keeps the current value: an older client does not send it.
  p_metadata_language text DEFAULT NULL
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
    poster_source = coalesce(p_poster_source, poster_source),
    new_titles_settings = coalesce(p_new_titles_settings, new_titles_settings),
    catalog_name_prefix = coalesce(p_catalog_name_prefix, catalog_name_prefix),
    metadata_language = coalesce(p_metadata_language, metadata_language)
  WHERE id = p_account_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO lists FROM public.lists l
  WHERE l.account_id = p_account_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean, text, jsonb, boolean, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean, text, jsonb, boolean, text)
TO service_role;

CREATE FUNCTION public.create_account_with_config(
  p_rpdb_api_key text,
  p_lists jsonb,
  p_new_titles_catalog boolean DEFAULT NULL,
  p_poster_source text DEFAULT NULL,
  p_new_titles_settings jsonb DEFAULT NULL,
  p_catalog_name_prefix boolean DEFAULT NULL,
  p_metadata_language text DEFAULT NULL
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
    p_poster_source, p_new_titles_settings, p_catalog_name_prefix,
    p_metadata_language
  ) AS saved;
END;
$$;

REVOKE ALL ON FUNCTION public.create_account_with_config(text, jsonb, boolean, text, jsonb, boolean, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_account_with_config(text, jsonb, boolean, text, jsonb, boolean, text)
TO service_role;
