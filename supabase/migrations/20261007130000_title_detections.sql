-- Newly detected titles (STR-60, ADR 0007).
--
-- * `accounts.new_titles_catalog`: whether the manifest offers the "New titles"
--   catalog.
--
-- The detection history itself is not in Postgres: it is one R2 object per
-- Account and Source list (ADR 0008), so no table or function here grows with
-- the size of the watchlists.

ALTER TABLE public.accounts
  ADD COLUMN new_titles_catalog boolean NOT NULL DEFAULT false;

-- Replace an Account's Lists and settings in one transaction. The "New
-- titles" setting is saved with the Lists, so a save never leaves one
-- request's Lists with another request's setting. A List whose saved merged
-- Source lists changed since the API checked them is refused
-- (`expected_merged_sources`, STR-59).
CREATE FUNCTION public.replace_account_config(
  p_account_id text,
  p_rpdb_api_key text,
  p_lists jsonb,
  p_actions_enabled boolean,
  p_action_providers text[],
  -- NULL keeps the current value, like the Actions settings.
  p_new_titles_catalog boolean DEFAULT NULL
)
RETURNS TABLE (deleted_ids uuid[], lists jsonb)
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

  WITH removed AS (
    DELETE FROM public.lists l
    WHERE l.account_id = p_account_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
        WHERE (value->>'id')::uuid = l.id
      )
    RETURNING l.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO deleted_ids FROM removed;

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
    new_titles_catalog = coalesce(p_new_titles_catalog, new_titles_catalog)
  WHERE id = p_account_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO lists FROM public.lists l
  WHERE l.account_id = p_account_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean)
TO service_role;
