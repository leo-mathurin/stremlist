-- Writes of several rows that must not stop half way (STR-16).
--
-- * `save_connection` and `delete_connection`: a Connection is saved or
--   deleted together with the detection history that belongs to its
--   Provider user, and a deleted one also takes the sync statuses of the
--   Source lists read through it. The token revoke and the R2 objects stay
--   outside: they cannot join a transaction.
-- * `create_account_with_config` and `copy_legacy_account`: a new Account
--   gets its first configuration, and a Legacy alias install gets its
--   private copy (ADR 0001), in one transaction each, so a failure never
--   leaves an Account without its Lists or a copied Legacy alias not marked
--   as moved.
-- * `replace_account_config` returns the Lists that it replaced, read under
--   its lock, instead of the IDs it deleted: the caller compares them with
--   the saved Lists to delete exactly the caches that the save left unused.

-- ---------------------------------------------------------------------------
-- replace_account_config
-- ---------------------------------------------------------------------------

DROP FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[], boolean);

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

-- ---------------------------------------------------------------------------
-- New Accounts and private copies
-- ---------------------------------------------------------------------------

-- Create an Account with a generated ID and its first Lists and settings
-- (`replace_account_config`, in the same transaction).
CREATE FUNCTION public.create_account_with_config(
  p_rpdb_api_key text,
  p_lists jsonb,
  p_new_titles_catalog boolean DEFAULT NULL
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
    new_id, p_rpdb_api_key, p_lists, NULL, NULL, p_new_titles_catalog
  ) AS saved;
END;
$$;

REVOKE ALL ON FUNCTION public.create_account_with_config(text, jsonb, boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_account_with_config(text, jsonb, boolean)
TO service_role;

-- Give a Legacy alias install a private Addon URL (ADR 0001): a new Account
-- with a copy of its Lists (in their order, positions from 0) and settings,
-- and the Legacy alias marked as moved. The Legacy Account keeps its Lists,
-- so the old install keeps serving its public ones. Actions settings and
-- detection history are not copied: the copy starts with its own Baseline.
CREATE FUNCTION public.copy_legacy_account(p_legacy_id text)
RETURNS public.accounts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  legacy public.accounts;
  private_copy public.accounts;
BEGIN
  -- Locked like a save, so the copy never mixes two saves of the alias.
  SELECT * INTO legacy FROM public.accounts a
  WHERE a.id = p_legacy_id AND a.legacy_imdb_user_id IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Legacy account not found';
  END IF;

  INSERT INTO public.accounts (is_active, rpdb_api_key, new_titles_catalog)
  VALUES (true, legacy.rpdb_api_key, legacy.new_titles_catalog)
  RETURNING * INTO private_copy;

  INSERT INTO public.lists (
    account_id, provider, source_ref, catalog_title, sort_option,
    display_mode, position, catalog_settings, merged_sources, source_label
  )
  SELECT private_copy.id, l.provider, l.source_ref, l.catalog_title,
    l.sort_option, l.display_mode,
    (row_number() OVER (ORDER BY l.position, l.created_at) - 1)::integer,
    l.catalog_settings, l.merged_sources, l.source_label
  FROM public.lists l
  WHERE l.account_id = legacy.id;

  UPDATE public.accounts a SET moved_at = now() WHERE a.id = legacy.id;

  RETURN private_copy;
END;
$$;

REVOKE ALL ON FUNCTION public.copy_legacy_account(text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_legacy_account(text)
TO service_role;

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

-- Save a new authorization. A new Connection can be another Provider user:
-- the history of the Source lists that only a Connection can read stays
-- only for the user of this one (`forget_connection_history`).
CREATE FUNCTION public.save_connection(
  p_account_id text,
  p_provider text,
  p_provider_username text,
  -- Ciphertexts produced by the backend (CONNECTION_ENCRYPTION_KEY).
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_scope text,
  p_redirect_uri text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.connections AS c (
    account_id, provider, provider_username, access_token, refresh_token,
    expires_at, scope, redirect_uri, needs_renewal_since, updated_at
  ) VALUES (
    p_account_id, p_provider, p_provider_username, p_access_token,
    p_refresh_token, p_expires_at, p_scope, p_redirect_uri, NULL, now()
  )
  ON CONFLICT (account_id, provider) DO UPDATE SET
    provider_username = EXCLUDED.provider_username,
    access_token = EXCLUDED.access_token,
    refresh_token = EXCLUDED.refresh_token,
    expires_at = EXCLUDED.expires_at,
    scope = EXCLUDED.scope,
    redirect_uri = EXCLUDED.redirect_uri,
    -- A new authorization replaces a refused one.
    needs_renewal_since = NULL,
    updated_at = EXCLUDED.updated_at;

  PERFORM public.forget_connection_history(p_account_id, p_provider);
END;
$$;

REVOKE ALL ON FUNCTION public.save_connection(text, text, text, text, text, timestamptz, text, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_connection(text, text, text, text, text, timestamptz, text, text)
TO service_role;

-- Delete a Connection with what describes the Source lists read through it:
-- the history of the Source lists that only a Connection can read, and the
-- sync statuses of the given Source lists (`p_list_ids` and `p_source_refs`
-- are parallel arrays, on this Provider; the other Source lists of a merged
-- List keep theirs). Only Lists of this Account are touched.
CREATE FUNCTION public.delete_connection(
  p_account_id text,
  p_provider text,
  p_list_ids uuid[],
  p_source_refs text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(cardinality(p_list_ids), 0)
    IS DISTINCT FROM coalesce(cardinality(p_source_refs), 0) THEN
    RAISE EXCEPTION 'List IDs and Source list refs must have the same length';
  END IF;

  DELETE FROM public.connections c
  WHERE c.account_id = p_account_id AND c.provider = p_provider;

  -- No Connection now: every Connection-only history of the Provider goes.
  PERFORM public.forget_connection_history(p_account_id, p_provider);

  DELETE FROM public.list_sync_status s
  USING unnest(coalesce(p_list_ids, '{}'), coalesce(p_source_refs, '{}'))
      AS t(list_id, source_ref),
    public.lists l
  WHERE s.list_id = t.list_id
    AND s.provider = p_provider
    AND s.source_ref = t.source_ref
    AND l.id = s.list_id
    AND l.account_id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_connection(text, text, uuid[], text[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_connection(text, text, uuid[], text[])
TO service_role;
