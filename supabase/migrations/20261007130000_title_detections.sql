-- Newly detected titles (STR-60, ADR 0007).
--
-- * `source_list_syncs`: one row per Account and Source list, written at the
--   first complete, successful synchronization (the Baseline) and moved on at
--   each later one.
-- * `source_list_entries`: the durable history. One row per entry key (the
--   stable identity of an entry in the Source list) that a complete
--   synchronization contained, resolved or not. `detected_at` stays NULL for
--   entries of the Baseline; `imdb_id` stays NULL until the entry resolves.
-- * `accounts.new_titles_catalog`: whether the manifest offers the "New titles"
--   catalog.
--
-- Rows are keyed by the Source list, not by the List, so the history stays
-- when a List is removed and added again, and never mixes two Source lists
-- when a List is changed to point somewhere else.

ALTER TABLE public.accounts
  ADD COLUMN new_titles_catalog boolean NOT NULL DEFAULT false;

-- The "New titles" setting is saved in the same transaction as the Lists, so a
-- save never leaves one request's Lists with another request's setting.
DROP FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[]);

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
      display_mode, position, catalog_settings
    ) VALUES (
      coalesce((item->>'id')::uuid, gen_random_uuid()),
      p_account_id, item->>'provider', item->>'source_ref',
      item->>'catalog_title', item->>'sort_option', item->>'display_mode',
      (item->>'position')::integer, coalesce(item->'catalog_settings', '{}'::jsonb)
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

CREATE TABLE public.source_list_syncs (
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_ref text NOT NULL,
  -- The first complete, successful synchronization: its entries are the
  -- Baseline and never count as detected.
  baseline_at timestamptz NOT NULL,
  -- The latest complete, successful synchronization, which the next one is
  -- compared with.
  last_complete_sync_at timestamptz NOT NULL,
  -- Whether only a Connection can read the Source list (`me/history`…). Its
  -- history then belongs to `connection_user`, the Provider user of that
  -- Connection: another user means another history.
  requires_connection boolean NOT NULL DEFAULT false,
  connection_user text,
  PRIMARY KEY (account_id, provider, source_ref),
  CHECK (requires_connection OR connection_user IS NULL)
);
ALTER TABLE public.source_list_syncs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.source_list_entries (
  account_id text NOT NULL,
  provider text NOT NULL,
  source_ref text NOT NULL,
  -- The Provider's ID for the entry ("trakt-movie:123", "imdb:tt0111161"),
  -- or a normalized title and year when the Provider gives no ID.
  entry_key text NOT NULL,
  -- The Title, once the entry resolves. NULL: an Unresolved entry.
  imdb_id text,
  -- The complete synchronization that first had this entry when the one
  -- before did not. NULL: the entry is part of the Baseline. A later
  -- resolution keeps this date.
  detected_at timestamptz,
  -- Set when a complete synchronization no longer has the entry, cleared
  -- when one has it again. A removal never deletes the row, so an entry that
  -- comes back keeps its first detection.
  removed_at timestamptz,
  PRIMARY KEY (account_id, provider, source_ref, entry_key),
  FOREIGN KEY (account_id, provider, source_ref)
    REFERENCES public.source_list_syncs (account_id, provider, source_ref)
    ON DELETE CASCADE
);
ALTER TABLE public.source_list_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX source_list_entries_account_title_idx
  ON public.source_list_entries (account_id, imdb_id)
  WHERE imdb_id IS NOT NULL;

-- Record one complete, successful synchronization of a Source list: no
-- Provider error and every page read. Unresolved entries are allowed: they
-- come with a NULL IMDb ID and are tracked by their entry key. The caller
-- never sends a failed or cut-short read, so it can never look like a
-- removal.
--
-- `p_entry_keys` and `p_imdb_ids` are parallel arrays. Returns the number of
-- new entries: 0 for the Baseline, NULL when a more recent synchronization
-- was already recorded (a slow concurrent read must not undo a newer one).
CREATE FUNCTION public.record_source_list_sync(
  p_account_id text,
  p_provider text,
  p_source_ref text,
  p_entry_keys text[],
  p_imdb_ids text[],
  p_synced_at timestamptz,
  -- Set for Source lists that only a Connection can read, with the Provider
  -- user that the read went through.
  p_requires_connection boolean DEFAULT false,
  p_connection_user text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  keys text[];
  ids text[];
  last_sync timestamptz;
  added integer;
BEGIN
  IF coalesce(cardinality(p_entry_keys), 0)
    IS DISTINCT FROM coalesce(cardinality(p_imdb_ids), 0) THEN
    RAISE EXCEPTION 'Entry keys and IMDb IDs must have the same length';
  END IF;

  -- One pair per entry key; a resolved duplicate wins over an unresolved one.
  SELECT coalesce(array_agg(k ORDER BY k), '{}'), coalesce(array_agg(i ORDER BY k), '{}')
  INTO keys, ids
  FROM (
    SELECT DISTINCT ON (k) k, i
    FROM unnest(coalesce(p_entry_keys, '{}'), coalesce(p_imdb_ids, '{}')) AS t(k, i)
    WHERE k IS NOT NULL
    ORDER BY k, i NULLS LAST
  ) AS unique_entries;

  IF p_requires_connection THEN
    -- The Connection must still be the one that the read went through. The
    -- row lock makes a concurrent disconnect wait until this transaction
    -- ends, so its history cleanup always runs after this write.
    PERFORM 1 FROM public.connections c
    WHERE c.account_id = p_account_id
      AND c.provider = p_provider
      AND c.provider_username IS NOT DISTINCT FROM p_connection_user
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    -- Another Provider user: the old history is not theirs.
    DELETE FROM public.source_list_syncs s
    WHERE s.account_id = p_account_id
      AND s.provider = p_provider
      AND s.source_ref = p_source_ref
      AND s.connection_user IS DISTINCT FROM p_connection_user;
  END IF;

  INSERT INTO public.source_list_syncs (
    account_id, provider, source_ref, baseline_at, last_complete_sync_at,
    requires_connection, connection_user
  ) VALUES (
    p_account_id, p_provider, p_source_ref, p_synced_at, p_synced_at,
    p_requires_connection, CASE WHEN p_requires_connection THEN p_connection_user END
  )
  ON CONFLICT DO NOTHING;

  IF FOUND THEN
    INSERT INTO public.source_list_entries (
      account_id, provider, source_ref, entry_key, imdb_id
    )
    SELECT p_account_id, p_provider, p_source_ref, k, i
    FROM unnest(keys, ids) AS t(k, i);
    RETURN 0;
  END IF;

  SELECT s.last_complete_sync_at INTO last_sync
  FROM public.source_list_syncs s
  WHERE s.account_id = p_account_id
    AND s.provider = p_provider
    AND s.source_ref = p_source_ref
  FOR UPDATE;

  IF p_synced_at <= last_sync THEN
    RETURN NULL;
  END IF;

  -- Entries that are gone: marked, never deleted.
  UPDATE public.source_list_entries d
  SET removed_at = p_synced_at
  WHERE d.account_id = p_account_id
    AND d.provider = p_provider
    AND d.source_ref = p_source_ref
    AND d.removed_at IS NULL
    AND d.entry_key <> ALL (keys);

  -- Entries that are back, and entries that resolved since the last time.
  -- Their detection date does not change.
  UPDATE public.source_list_entries d
  SET removed_at = NULL,
    imdb_id = coalesce(t.i, d.imdb_id)
  FROM unnest(keys, ids) AS t(k, i)
  WHERE d.account_id = p_account_id
    AND d.provider = p_provider
    AND d.source_ref = p_source_ref
    AND d.entry_key = t.k
    AND (
      d.removed_at IS NOT NULL
      OR (t.i IS NOT NULL AND t.i IS DISTINCT FROM d.imdb_id)
    );

  -- New entries, resolved or not, dated by this synchronization.
  INSERT INTO public.source_list_entries (
    account_id, provider, source_ref, entry_key, imdb_id, detected_at
  )
  SELECT p_account_id, p_provider, p_source_ref, k, i, p_synced_at
  FROM unnest(keys, ids) AS t(k, i)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;

  UPDATE public.source_list_syncs s
  SET last_complete_sync_at = p_synced_at
  WHERE s.account_id = p_account_id
    AND s.provider = p_provider
    AND s.source_ref = p_source_ref;

  RETURN added;
END;
$$;

REVOKE ALL ON FUNCTION public.record_source_list_sync(text, text, text, text[], text[], timestamptz, boolean, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_source_list_sync(text, text, text, text[], text[], timestamptz, boolean, text)
TO service_role;

-- The "New titles" of an Account in the given Source lists, one row per
-- Title with its earliest detection, newest first. Within one Source list a
-- Title is new only when none of its entries is in the Baseline (an entry
-- whose key changed is still the same Title). It is shown while one of the
-- Source lists where it is new still has it. Its date is the first
-- appearance of its first detected entry, whatever happened after.
CREATE FUNCTION public.list_new_titles(
  p_account_id text,
  p_providers text[],
  p_source_refs text[],
  p_limit integer
)
RETURNS TABLE (
  imdb_id text,
  provider text,
  source_ref text,
  detected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH sources AS (
    SELECT DISTINCT p, r FROM unnest(p_providers, p_source_refs) AS s(p, r)
  ),
  per_source AS (
    SELECT d.imdb_id, d.provider, d.source_ref,
      min(d.detected_at) AS detected_at,
      bool_or(d.detected_at IS NULL) AS in_baseline,
      bool_or(d.removed_at IS NULL) AS present
    FROM public.source_list_entries d
    JOIN sources ON sources.p = d.provider AND sources.r = d.source_ref
    WHERE d.account_id = p_account_id AND d.imdb_id IS NOT NULL
    GROUP BY d.imdb_id, d.provider, d.source_ref
  ),
  -- The earliest Detection among the Source lists where the Title is new,
  -- also when it has left that one since: removing it from one List must
  -- not give it a later date while another List still has it.
  earliest AS (
    SELECT DISTINCT ON (ps.imdb_id) ps.imdb_id, ps.provider, ps.source_ref,
      ps.detected_at
    FROM per_source ps
    WHERE NOT ps.in_baseline
    ORDER BY ps.imdb_id, ps.detected_at, ps.provider, ps.source_ref
  )
  SELECT e.imdb_id, e.provider, e.source_ref, e.detected_at
  FROM earliest e
  -- Shown while one of those Source lists still has it.
  WHERE EXISTS (
    SELECT 1 FROM per_source ps
    WHERE ps.imdb_id = e.imdb_id AND ps.present AND NOT ps.in_baseline
  )
  ORDER BY e.detected_at DESC, e.imdb_id
  LIMIT greatest(coalesce(p_limit, 1000), 0);
$$;

REVOKE ALL ON FUNCTION public.list_new_titles(text, text[], text[], integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_new_titles(text, text[], text[], integer)
TO service_role;

-- Forget the history of Source lists that only a Connection can read, after
-- a disconnect or a new Connection. Only the history of the Provider user of
-- the current Connection stays (none after a disconnect). That user is read
-- when the rows are deleted, so a refresh or a newer Connection that comes
-- in between (even a reconnect right after a disconnect) keeps its history.
-- The entries go with their row (ON DELETE CASCADE).
CREATE FUNCTION public.forget_connection_history(
  p_account_id text,
  p_provider text
)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH current_connection AS (
    SELECT c.provider_username
    FROM public.connections c
    WHERE c.account_id = p_account_id AND c.provider = p_provider
  ),
  forgotten AS (
    DELETE FROM public.source_list_syncs s
    WHERE s.account_id = p_account_id
      AND s.provider = p_provider
      AND s.requires_connection
      AND (
        NOT EXISTS (SELECT 1 FROM current_connection)
        OR s.connection_user IS DISTINCT FROM
          (SELECT provider_username FROM current_connection)
      )
    RETURNING 1
  )
  SELECT count(*)::integer FROM forgotten;
$$;

REVOKE ALL ON FUNCTION public.forget_connection_history(text, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forget_connection_history(text, text)
TO service_role;
