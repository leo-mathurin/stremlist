-- Merged Lists (STR-59).
--
-- A List can read several Source lists and show their Titles once each in
-- the same Catalogs (ADR 0006). `provider` + `source_ref` stay the List's
-- first Source list, so every List keeps working unchanged;
-- `merged_sources` holds the others, in order, as
-- `[{"provider": "trakt", "source_ref": "users/x/watchlist"}, …]`, with an
-- optional "label" (the title of the List it came from, for the configure
-- page only). `source_label` is that label for the first Source list, when
-- an edit moved a merged Source list to the first place.
-- The backend checks the merge rules (at most 5 Source lists per List, each
-- Source list once per Account, display mode, date sort).

ALTER TABLE public.lists
  ADD COLUMN merged_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.lists
  ADD CONSTRAINT lists_merged_sources_is_array
  CHECK (jsonb_typeof(merged_sources) = 'array');
ALTER TABLE public.lists ADD COLUMN source_label text;

-- Same signature: the INSERT and the UPDATE learn the new columns, and a
-- List whose saved merged Source lists changed since the API checked them
-- is refused (`expected_merged_sources`).
CREATE OR REPLACE FUNCTION public.replace_account_config(
  p_account_id text,
  p_rpdb_api_key text,
  p_lists jsonb,
  p_actions_enabled boolean,
  p_action_providers text[]
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
    action_providers = coalesce(p_action_providers, action_providers)
  WHERE id = p_account_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO lists FROM public.lists l
  WHERE l.account_id = p_account_id;
  RETURN NEXT;
END;
$$;

