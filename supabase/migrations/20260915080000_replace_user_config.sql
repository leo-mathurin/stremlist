CREATE FUNCTION public.replace_user_config(
  p_owner_user_id text,
  p_rpdb_api_key text,
  p_watchlists jsonb
)
RETURNS TABLE (deleted_ids uuid[], watchlists jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
BEGIN
  -- Serialize replacements, including requests that only create new rows.
  PERFORM 1 FROM public.users
  WHERE imdb_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF jsonb_typeof(p_watchlists) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Watchlists must be an array';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_watchlists) AS entries(value)
    WHERE value ? 'id' AND NOT EXISTS (
      SELECT 1 FROM public.user_watchlists uw
      WHERE uw.id = (value->>'id')::uuid
        AND uw.owner_user_id = p_owner_user_id
    )
  ) THEN
    RAISE EXCEPTION 'Watchlist does not belong to this user';
  END IF;

  IF EXISTS (
    SELECT value->>'id' FROM jsonb_array_elements(p_watchlists) AS entries(value)
    WHERE value ? 'id' GROUP BY value->>'id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate watchlist ID';
  END IF;

  WITH removed AS (
    DELETE FROM public.user_watchlists uw
    WHERE uw.owner_user_id = p_owner_user_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_watchlists) AS entries(value)
        WHERE (value->>'id')::uuid = uw.id
      )
    RETURNING uw.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO deleted_ids FROM removed;

  FOR item IN SELECT value FROM jsonb_array_elements(p_watchlists)
  LOOP
    INSERT INTO public.user_watchlists AS uw (
      id, owner_user_id, imdb_user_id, catalog_title, sort_option,
      display_mode, position, catalog_settings
    ) VALUES (
      coalesce((item->>'id')::uuid, gen_random_uuid()),
      p_owner_user_id, item->>'imdb_user_id', item->>'catalog_title',
      item->>'sort_option', item->>'display_mode',
      (item->>'position')::integer, coalesce(item->'catalog_settings', '{}'::jsonb)
    )
    ON CONFLICT (id) DO UPDATE SET
      imdb_user_id = EXCLUDED.imdb_user_id,
      catalog_title = EXCLUDED.catalog_title,
      sort_option = EXCLUDED.sort_option,
      display_mode = EXCLUDED.display_mode,
      position = EXCLUDED.position,
      -- Omitted settings preserve the locked row, not a client-side snapshot.
      catalog_settings = CASE WHEN item ? 'catalog_settings'
        THEN EXCLUDED.catalog_settings ELSE uw.catalog_settings END,
      updated_at = now()
    WHERE uw.owner_user_id = p_owner_user_id;
  END LOOP;

  UPDATE public.users SET rpdb_api_key = p_rpdb_api_key
  WHERE imdb_user_id = p_owner_user_id;

  SELECT coalesce(jsonb_agg(to_jsonb(uw) ORDER BY uw.position, uw.created_at), '[]'::jsonb)
  INTO watchlists FROM public.user_watchlists uw
  WHERE uw.owner_user_id = p_owner_user_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_user_config(text, text, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_config(text, text, jsonb)
TO service_role;
