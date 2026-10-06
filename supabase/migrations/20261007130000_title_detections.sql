-- Newly detected titles (STR-60, ADR 0004).
--
-- * `source_list_syncs`: one row per Account and Source list, written at the
--   first complete, successful synchronization (the Baseline) and moved on at
--   each later one.
-- * `title_detections`: the durable history. One row per Title that a
--   complete synchronization of the Source list contained. `detected_at` stays
--   NULL for Titles of the Baseline.
-- * `accounts.new_titles_catalog`: whether the manifest offers the "New titles"
--   catalog.
--
-- Rows are keyed by the Source list, not by the List, so the history stays
-- when a List is removed and added again, and never mixes two Source lists
-- when a List is changed to point somewhere else.

ALTER TABLE public.accounts
  ADD COLUMN new_titles_catalog boolean NOT NULL DEFAULT false;

CREATE TABLE public.source_list_syncs (
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_ref text NOT NULL,
  -- The first complete, successful synchronization: its Titles are the
  -- Baseline and never count as detected.
  baseline_at timestamptz NOT NULL,
  -- The latest complete, successful synchronization, which the next one is
  -- compared with.
  last_complete_sync_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, provider, source_ref)
);
ALTER TABLE public.source_list_syncs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.title_detections (
  account_id text NOT NULL,
  provider text NOT NULL,
  source_ref text NOT NULL,
  imdb_id text NOT NULL,
  -- The complete synchronization that first had this Title when the one
  -- before did not. NULL: the Title is part of the Baseline.
  detected_at timestamptz,
  -- Set when a complete synchronization no longer has the Title, cleared when
  -- one has it again. A removal never deletes the row, so a Title that comes
  -- back keeps its first detection.
  removed_at timestamptz,
  PRIMARY KEY (account_id, provider, source_ref, imdb_id),
  FOREIGN KEY (account_id, provider, source_ref)
    REFERENCES public.source_list_syncs (account_id, provider, source_ref)
    ON DELETE CASCADE
);
ALTER TABLE public.title_detections ENABLE ROW LEVEL SECURITY;

CREATE INDEX title_detections_account_detected_idx
  ON public.title_detections (account_id, detected_at DESC)
  WHERE detected_at IS NOT NULL;

-- Record one complete, successful synchronization of a Source list. The
-- caller only sends complete ones: a failed or incomplete synchronization is
-- never recorded, so it can never look like a removal.
--
-- Returns the number of newly detected Titles: 0 for the Baseline, NULL when
-- a more recent synchronization was already recorded (a slow concurrent read
-- must not undo a newer one).
CREATE FUNCTION public.record_source_list_sync(
  p_account_id text,
  p_provider text,
  p_source_ref text,
  p_imdb_ids text[],
  p_synced_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  ids text[] := ARRAY(
    SELECT DISTINCT id FROM unnest(coalesce(p_imdb_ids, '{}'::text[])) AS t(id)
    WHERE id IS NOT NULL
  );
  last_sync timestamptz;
  detected integer;
BEGIN
  INSERT INTO public.source_list_syncs (
    account_id, provider, source_ref, baseline_at, last_complete_sync_at
  ) VALUES (p_account_id, p_provider, p_source_ref, p_synced_at, p_synced_at)
  ON CONFLICT DO NOTHING;

  IF FOUND THEN
    INSERT INTO public.title_detections (account_id, provider, source_ref, imdb_id)
    SELECT p_account_id, p_provider, p_source_ref, id FROM unnest(ids) AS t(id);
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

  -- Only rows whose state changes: present ones that are now absent, and
  -- removed ones that are back.
  UPDATE public.title_detections d
  SET removed_at = CASE WHEN d.imdb_id = ANY (ids) THEN NULL ELSE p_synced_at END
  WHERE d.account_id = p_account_id
    AND d.provider = p_provider
    AND d.source_ref = p_source_ref
    AND (d.removed_at IS NULL) = NOT (d.imdb_id = ANY (ids));

  INSERT INTO public.title_detections (
    account_id, provider, source_ref, imdb_id, detected_at
  )
  SELECT p_account_id, p_provider, p_source_ref, id, p_synced_at
  FROM unnest(ids) AS t(id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS detected = ROW_COUNT;

  UPDATE public.source_list_syncs s
  SET last_complete_sync_at = p_synced_at
  WHERE s.account_id = p_account_id
    AND s.provider = p_provider
    AND s.source_ref = p_source_ref;

  RETURN detected;
END;
$$;

REVOKE ALL ON FUNCTION public.record_source_list_sync(text, text, text, text[], timestamptz)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_source_list_sync(text, text, text, text[], timestamptz)
TO service_role;
