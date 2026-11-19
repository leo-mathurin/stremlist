-- Two independent activity destinations, sharing the existing leased delivery queue.
ALTER TABLE public.watch_tracking ADD COLUMN consented_at timestamptz;
ALTER TABLE public.watch_destinations
  ADD COLUMN watched_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN watchlist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN last_kind text NOT NULL DEFAULT 'watched' CHECK (last_kind IN ('watched', 'watchlist'));
ALTER TABLE public.watch_writes
  ADD COLUMN kind text NOT NULL DEFAULT 'watched' CHECK (kind IN ('watched', 'watchlist'));
ALTER TABLE public.watch_writes DROP CONSTRAINT watch_writes_account_id_provider_imdb_id_season_episode_key;
ALTER TABLE public.watch_writes ADD UNIQUE (account_id, provider, imdb_id, season, episode, kind);

-- A successful addition keeps its receipt, so a repeated client event cannot send it again.
CREATE TABLE public.watch_library_receipts (
  account_id text NOT NULL,
  provider text NOT NULL,
  imdb_id text NOT NULL,
  PRIMARY KEY (account_id, provider, imdb_id),
  FOREIGN KEY (account_id, provider) REFERENCES public.watch_destinations(account_id, provider) ON DELETE CASCADE
);
ALTER TABLE public.watch_library_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.watch_library_receipts FROM anon, authenticated;
GRANT ALL ON public.watch_library_receipts TO service_role;

CREATE FUNCTION public.configure_watch_activity(p_account_id text, p_watched text[], p_watchlist text[], p_consent boolean)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE t public.watch_tracking;
BEGIN
  SELECT * INTO t FROM public.watch_tracking WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    IF cardinality(p_watched) + cardinality(p_watchlist) > 0 THEN RAISE EXCEPTION 'tracking-not-ready'; END IF;
    RETURN;
  END IF;
  IF t.consented_at IS NULL AND NOT p_consent AND EXISTS (
    SELECT 1 FROM (
      SELECT unnest(p_watched) provider, 'watched' kind UNION ALL SELECT unnest(p_watchlist), 'watchlist'
    ) x LEFT JOIN public.watch_destinations d ON d.account_id = p_account_id AND d.provider = x.provider
    WHERE NOT coalesce(CASE WHEN x.kind = 'watched' THEN d.watched_enabled ELSE d.watchlist_enabled END, false)
  ) THEN RAISE EXCEPTION 'consent-required'; END IF;
  IF cardinality(p_watched) + cardinality(p_watchlist) > 0 AND t.baseline_at IS NULL THEN
    RAISE EXCEPTION 'tracking-not-ready';
  END IF;
  IF p_consent THEN
    UPDATE public.watch_tracking SET consented_at = coalesce(consented_at, now()) WHERE account_id = p_account_id;
  END IF;
  INSERT INTO public.watch_destinations (account_id, provider, watched_enabled, watchlist_enabled)
  SELECT p_account_id, provider, provider = ANY(p_watched), provider = ANY(p_watchlist)
  FROM (SELECT unnest(p_watched || p_watchlist) provider) x GROUP BY provider
  ON CONFLICT (account_id, provider) DO UPDATE SET watched_enabled = excluded.watched_enabled, watchlist_enabled = excluded.watchlist_enabled;
  DELETE FROM public.watch_writes w WHERE w.account_id = p_account_id AND
    NOT (CASE WHEN w.kind = 'watched' THEN w.provider = ANY(p_watched) ELSE w.provider = ANY(p_watchlist) END);
  DELETE FROM public.watch_library_receipts r WHERE r.account_id = p_account_id AND NOT r.provider = ANY(p_watchlist);
  UPDATE public.watch_destinations SET watched_enabled = provider = ANY(p_watched), watchlist_enabled = provider = ANY(p_watchlist)
  WHERE account_id = p_account_id;
  DELETE FROM public.watch_destinations WHERE account_id = p_account_id AND NOT watched_enabled AND NOT watchlist_enabled;
  IF cardinality(p_watched) = 0 THEN DELETE FROM public.watch_reads WHERE account_id = p_account_id; END IF;
END;
$$;

CREATE FUNCTION public.queue_library_addition(p_account_id text, p_imdb_id text, p_type text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  -- The same row lock as settings serializes opt-out with event receipt creation.
  PERFORM 1 FROM public.watch_tracking WHERE account_id = p_account_id AND consented_at IS NOT NULL AND baseline_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF p_imdb_id !~ '^tt[0-9]+$' OR p_type NOT IN ('movie', 'series') THEN RETURN 0; END IF;
  WITH fresh AS (
    INSERT INTO public.watch_library_receipts (account_id, provider, imdb_id)
    SELECT d.account_id, d.provider, p_imdb_id FROM public.watch_destinations d
    JOIN public.stremio_connections s ON s.account_id = d.account_id
    WHERE d.account_id = p_account_id AND d.watchlist_enabled
    ON CONFLICT DO NOTHING RETURNING *
  )
  INSERT INTO public.watch_writes (account_id, provider, imdb_id, item_type, watched_at, kind)
  SELECT account_id, provider, imdb_id, p_type, now(), 'watchlist' FROM fresh
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION public.watch_recover_cycle(p_account_id text, p_item_id text, p_type text, p_video_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.watch_tracking WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.watch_destinations WHERE account_id = p_account_id AND watched_enabled) THEN RETURN; END IF;
  -- Native saved status and the existing watched baseline decide what can be sent.
  -- Same-video events keep the cycle, but invalidate an in-flight finish.
  INSERT INTO public.watch_reads AS r (account_id, item_id, item_type, video_id, due_at, phase, cycle_started_at, start_state)
  VALUES (p_account_id, p_item_id, p_type, p_video_id, now(), 'warmup', now(), '{}')
  ON CONFLICT (account_id, item_id) DO UPDATE SET
    due_at = least(r.due_at, now()),
    generation = r.generation + CASE WHEN r.video_id <> excluded.video_id OR r.lease_token IS NOT NULL THEN 1 ELSE 0 END,
    video_id = excluded.video_id,
    item_type = excluded.item_type,
    cycle_started_at = CASE WHEN r.video_id <> excluded.video_id THEN now() ELSE r.cycle_started_at END,
    phase = CASE WHEN r.video_id <> excluded.video_id THEN 'warmup' ELSE r.phase END,
    start_state = CASE WHEN r.video_id <> excluded.video_id THEN '{}'::jsonb ELSE r.start_state END,
    expected_flip_at = CASE WHEN r.video_id <> excluded.video_id THEN NULL ELSE r.expected_flip_at END,
    expected_end_at = CASE WHEN r.video_id <> excluded.video_id THEN NULL ELSE r.expected_end_at END,
    last_time_watched = CASE WHEN r.video_id <> excluded.video_id THEN NULL ELSE r.last_time_watched END,
    last_moved_at = CASE WHEN r.video_id <> excluded.video_id THEN NULL ELSE r.last_moved_at END,
    failures = CASE WHEN r.video_id <> excluded.video_id THEN 0 ELSE r.failures END,
    locked_until = '-infinity', lease_token = NULL;
END;
$$;


CREATE OR REPLACE FUNCTION public.watch_destination_list(p_account_id text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(d.provider ORDER BY d.provider), '{}')
  FROM public.watch_destinations d
  WHERE d.account_id = p_account_id AND d.watched_enabled;
$$;

CREATE OR REPLACE FUNCTION public.watch_context(p_account_id text)
RETURNS TABLE (auth_key text, baseline_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT s.auth_key, t.baseline_at
  FROM public.watch_tracking t
  JOIN public.stremio_connections s ON s.account_id = t.account_id
  WHERE t.account_id = p_account_id AND EXISTS (SELECT 1 FROM public.watch_destinations d WHERE d.account_id = t.account_id AND d.watched_enabled);
$$;

CREATE OR REPLACE FUNCTION public.queue_watch_writes(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.watch_writes (
    account_id, provider, imdb_id, item_type, season, episode, watched_at
  )
  SELECT x.account_id, x.provider, x.imdb_id, x.item_type,
    coalesce(x.season, 0), coalesce(x.episode, 0), x.watched_at
  FROM jsonb_to_recordset(p_rows) AS x(
    account_id text, provider text, imdb_id text, item_type text,
    season integer, episode integer, watched_at timestamptz
  )
  JOIN public.watch_destinations d
    ON d.account_id = x.account_id AND d.provider = x.provider
  WHERE d.watched_enabled
  ON CONFLICT (account_id, provider, imdb_id, season, episode, kind) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_watch_writes(p_lease_token uuid, p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Successes: the newest title of each Destination.
  UPDATE public.watch_destinations d
  SET last_kind = s.kind, last_success_at = now(), last_error = NULL, last_error_at = NULL,
    last_title = jsonb_strip_nulls(jsonb_build_object(
      'imdbId', s.imdb_id, 'type', s.item_type,
      'season', nullif(s.season, 0), 'episode', nullif(s.episode, 0)
    ))
  FROM (
    SELECT DISTINCT ON (w.account_id, w.provider) w.*
    FROM jsonb_to_recordset(p_rows) AS i(id bigint, done boolean)
    JOIN public.watch_writes w
      ON w.id = i.id AND w.lease_token = p_lease_token
    WHERE i.done
    ORDER BY w.account_id, w.provider, w.id DESC
  ) s
  WHERE d.account_id = s.account_id AND d.provider = s.provider;

  -- Failures that the member can act on, and given-up writes.
  UPDATE public.watch_destinations d
  SET last_error = f.error, last_error_at = now()
  FROM (
    SELECT DISTINCT ON (w.account_id, w.provider) w.account_id, w.provider,
      CASE WHEN i.next_due_at IS NULL AND i.error IS DISTINCT FROM 'not_found'
        THEN 'gave_up' ELSE i.error END AS error
    FROM jsonb_to_recordset(p_rows) AS i(
      id bigint, done boolean, next_due_at timestamptz, error text
    )
    JOIN public.watch_writes w
      ON w.id = i.id AND w.lease_token = p_lease_token
    WHERE NOT i.done
      AND (i.next_due_at IS NULL OR i.error IN ('not_found', 'needs_renewal'))
    ORDER BY w.account_id, w.provider, w.id DESC
  ) f
  WHERE d.account_id = f.account_id AND d.provider = f.provider;

  DELETE FROM public.watch_writes w
  USING jsonb_to_recordset(p_rows) AS i(
    id bigint, done boolean, next_due_at timestamptz
  )
  WHERE w.id = i.id AND w.lease_token = p_lease_token
    AND (i.done OR i.next_due_at IS NULL);

  UPDATE public.watch_writes w
  SET due_at = i.next_due_at, attempts = w.attempts + 1,
    first_failed_at = coalesce(w.first_failed_at, now()),
    uncertain = coalesce(i.uncertain, false),
    last_error = i.error, locked_until = '-infinity', lease_token = NULL
  FROM jsonb_to_recordset(p_rows) AS i(
    id bigint, done boolean, next_due_at timestamptz, error text,
    uncertain boolean
  )
  WHERE w.id = i.id AND w.lease_token = p_lease_token
    AND NOT i.done AND i.next_due_at IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.watch_writes_drop_on_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.watch_writes w
  WHERE w.account_id = NEW.account_id AND w.provider = NEW.provider;
  DELETE FROM public.watch_library_receipts r WHERE r.account_id = NEW.account_id AND r.provider = NEW.provider;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_watch_activity(text,text[],text[],boolean), public.queue_library_addition(text,text,text), public.watch_recover_cycle(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_watch_activity(text,text[],text[],boolean), public.queue_library_addition(text,text,text), public.watch_recover_cycle(text,text,text,text) TO service_role;

CREATE FUNCTION public.discard_empty_watch_activity(p_account_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.watch_tracking WHERE account_id = p_account_id FOR UPDATE;
  DELETE FROM public.watch_tracking t WHERE t.account_id = p_account_id
    AND NOT EXISTS (SELECT 1 FROM public.watch_destinations d WHERE d.account_id = t.account_id);
END;
$$;
REVOKE ALL ON FUNCTION public.discard_empty_watch_activity(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discard_empty_watch_activity(text) TO service_role;
