-- Watch tracking (ADR 0003): Stremlist reads Stremio's watched status on a
-- schedule and marks new watched titles on the member's Destinations.
-- Postgres holds the tracked Accounts, their Destinations, the due reads and
-- the writes that wait for their turn or a retry. The previous watched state
-- of each Account is one R2 object (`watch/<account>/state.json`).
--
-- Only the backend's service role reads these tables: row level security is
-- on and no policy grants anon or authenticated access.

-- An Account with at least one Destination on.
CREATE TABLE public.watch_tracking (
  account_id text PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The minute of the 6-hour sweep cycle (0 to 359) when this Account is swept.
  sweep_slot smallint NOT NULL CHECK (sweep_slot BETWEEN 0 AND 359),
  -- Stremio's own Trakt integration is connected on the linked Stremio
  -- account: the Trakt Destination then gets nothing, so a play is never
  -- written twice.
  stremio_trakt boolean NOT NULL DEFAULT false,
  -- When the Watched baseline was saved in R2. Null: not read yet, and no
  -- watched title is sent before it is.
  baseline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_tracking_sweep_slot ON public.watch_tracking (sweep_slot);
ALTER TABLE public.watch_tracking ENABLE ROW LEVEL SECURITY;

-- A Connection that receives the watched titles of its Account. Deleting the
-- Connection deletes the Destination and its waiting writes.
CREATE TABLE public.watch_destinations (
  account_id text NOT NULL
    REFERENCES public.watch_tracking(account_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('trakt', 'simkl', 'mdblist')),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  -- The last title written, as {imdbId, type, season?, episode?}.
  last_title jsonb,
  last_success_at timestamptz,
  -- not_found (the Provider does not know the title), needs_renewal (connect
  -- again), gave_up (72 hours of failures). Cleared by the next success.
  last_error text,
  last_error_at timestamptz,
  PRIMARY KEY (account_id, provider),
  FOREIGN KEY (account_id, provider)
    REFERENCES public.connections(account_id, provider) ON DELETE CASCADE
);
ALTER TABLE public.watch_destinations ENABLE ROW LEVEL SECURITY;

-- Without Destinations, the Account is not tracked any more.
CREATE FUNCTION public.watch_tracking_drop_empty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.watch_tracking t
  WHERE t.account_id = OLD.account_id
    AND NOT EXISTS (
      SELECT 1 FROM public.watch_destinations d
      WHERE d.account_id = OLD.account_id
    );
  RETURN NULL;
END;
$$;
CREATE TRIGGER watch_destinations_drop_empty
AFTER DELETE ON public.watch_destinations
FOR EACH ROW EXECUTE FUNCTION public.watch_tracking_drop_empty();

-- One due read per Account and library item.
CREATE TABLE public.watch_reads (
  account_id text NOT NULL
    REFERENCES public.watch_tracking(account_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('movie', 'series')),
  -- The video of the /stream request (`tt…:season:episode` for an episode).
  video_id text NOT NULL,
  due_at timestamptz NOT NULL,
  -- A /stream request starts a new generation. A run that read an older one
  -- does not overwrite it.
  generation integer NOT NULL DEFAULT 1,
  -- warmup, wait, flip, stalled
  phase text NOT NULL,
  cycle_started_at timestamptz NOT NULL,
  expected_flip_at timestamptz,
  expected_end_at timestamptz,
  -- What was watched at the start of the cycle: {"timesWatched": n, "bits": "…"}
  start_state jsonb NOT NULL DEFAULT '{}',
  last_time_watched bigint,
  last_moved_at timestamptz,
  reads integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  locked_until timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  PRIMARY KEY (account_id, item_id)
);
CREATE INDEX watch_reads_due ON public.watch_reads (due_at);
ALTER TABLE public.watch_reads ENABLE ROW LEVEL SECURITY;

-- Destination writes waiting for their turn or for a retry. Movies have
-- season and episode 0, so one title is queued once per Destination.
CREATE TABLE public.watch_writes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  provider text NOT NULL,
  imdb_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('movie', 'series')),
  season integer NOT NULL DEFAULT 0,
  episode integer NOT NULL DEFAULT 0,
  watched_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  first_failed_at timestamptz,
  -- The last attempt may have reached the Provider (a timeout): read its
  -- history before the next one.
  uncertain boolean NOT NULL DEFAULT false,
  last_error text,
  locked_until timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  UNIQUE (account_id, provider, imdb_id, season, episode),
  FOREIGN KEY (account_id, provider)
    REFERENCES public.watch_destinations(account_id, provider) ON DELETE CASCADE
);
CREATE INDEX watch_writes_due ON public.watch_writes (provider, due_at);
ALTER TABLE public.watch_writes ENABLE ROW LEVEL SECURITY;

-- A Connection now linked to another Provider user: its waiting writes
-- belonged to the previous one, so they are dropped, never transferred. A
-- new authorization without a username (its read failed) cannot prove it is
-- the same user, so it drops them too.
CREATE FUNCTION public.watch_writes_drop_on_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.watch_writes w
  WHERE w.account_id = NEW.account_id AND w.provider = NEW.provider;
  RETURN NULL;
END;
$$;
CREATE TRIGGER connections_watch_new_user
AFTER UPDATE OF provider_username ON public.connections
FOR EACH ROW
WHEN (
  NEW.provider_username IS NULL
  OR OLD.provider_username IS DISTINCT FROM NEW.provider_username
)
EXECUTE FUNCTION public.watch_writes_drop_on_new_user();

-- The global Simkl limiter: slots spaced 1/rate apart (a virtual clock).
CREATE TABLE public.watch_simkl_gate (
  id text PRIMARY KEY CHECK (id = 'simkl'),
  next_slot_at timestamptz NOT NULL DEFAULT '-infinity',
  -- After a 429, the fast rate stays off until then.
  slow_until timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE public.watch_simkl_gate ENABLE ROW LEVEL SECURITY;
INSERT INTO public.watch_simkl_gate (id) VALUES ('simkl');

-- The last sweep minute done, so a missed minute is caught up.
CREATE TABLE public.watch_sweep_cursor (
  id text PRIMARY KEY CHECK (id = 'sweep'),
  last_slot_at timestamptz NOT NULL
);
ALTER TABLE public.watch_sweep_cursor ENABLE ROW LEVEL SECURITY;

-- Every Destination of an Account. Whether Trakt gets a title also depends
-- on Stremio's own Trakt, which the backend reads fresh before a send.
CREATE FUNCTION public.watch_destination_list(p_account_id text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(d.provider ORDER BY d.provider), '{}')
  FROM public.watch_destinations d
  WHERE d.account_id = p_account_id;
$$;

-- What a /stream request or a player event of a tracked Account needs: the
-- Stremio key. No row: the Account is not tracked or has no Stremio link.
CREATE FUNCTION public.watch_context(p_account_id text)
RETURNS TABLE (auth_key text, baseline_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT s.auth_key, t.baseline_at
  FROM public.watch_tracking t
  JOIN public.stremio_connections s ON s.account_id = t.account_id
  WHERE t.account_id = p_account_id;
$$;

-- A /stream request: start (or restart) the cycle of this item.
CREATE FUNCTION public.watch_restart(
  p_account_id text,
  p_item_id text,
  p_item_type text,
  p_video_id text,
  p_due_at timestamptz,
  p_phase text,
  p_start_state jsonb,
  p_last_time_watched bigint DEFAULT NULL,
  p_expected_flip_at timestamptz DEFAULT NULL,
  p_expected_end_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO public.watch_reads AS w (
    account_id, item_id, item_type, video_id, due_at, phase, cycle_started_at,
    start_state, last_time_watched, last_moved_at, expected_flip_at,
    expected_end_at, reads
  )
  SELECT p_account_id, p_item_id, p_item_type, p_video_id, p_due_at, p_phase,
    now(), p_start_state, p_last_time_watched, now(), p_expected_flip_at,
    p_expected_end_at, 1
  -- The Account may have stopped tracking meanwhile.
  WHERE EXISTS (
    SELECT 1 FROM public.watch_tracking t WHERE t.account_id = p_account_id
  )
  ON CONFLICT (account_id, item_id) DO UPDATE SET
    item_type = excluded.item_type,
    video_id = excluded.video_id,
    due_at = excluded.due_at,
    phase = excluded.phase,
    cycle_started_at = now(),
    start_state = excluded.start_state,
    last_time_watched = excluded.last_time_watched,
    last_moved_at = now(),
    expected_flip_at = excluded.expected_flip_at,
    expected_end_at = excluded.expected_end_at,
    reads = w.reads + 1,
    failures = 0,
    generation = w.generation + 1;
$$;

-- A Stremio Web `pause` or `stop` event: read the item at the next run,
-- unless it cannot be watched yet (more than 10 minutes before the
-- threshold).

CREATE FUNCTION public.watch_read_soon(p_account_id text, p_item_id text)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH moved AS (
    UPDATE public.watch_reads
    SET due_at = least(due_at, now())
    WHERE account_id = p_account_id AND item_id = p_item_id
      AND (expected_flip_at IS NULL
        OR expected_flip_at <= now() + interval '10 minutes')
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM moved);
$$;

-- Claim due reads with a lease. Each row carries what the run needs for its
-- Account, so a run makes no other lookup per read.
CREATE FUNCTION public.claim_watch_reads(
  p_limit integer,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS TABLE (
  account_id text, item_id text, item_type text, video_id text,
  due_at timestamptz, generation integer, phase text,
  cycle_started_at timestamptz, expected_flip_at timestamptz,
  expected_end_at timestamptz, start_state jsonb, last_time_watched bigint,
  last_moved_at timestamptz, reads integer, failures integer,
  auth_key text, baseline_at timestamptz, stremio_trakt boolean,
  destinations text[]
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH due AS (
    SELECT r.account_id, r.item_id
    FROM public.watch_reads r
    WHERE r.due_at <= now() AND r.locked_until <= now()
    ORDER BY r.due_at
    LIMIT least(greatest(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.watch_reads r
    SET locked_until = now() + make_interval(secs => p_lease_seconds),
      lease_token = p_lease_token
    FROM due
    WHERE r.account_id = due.account_id AND r.item_id = due.item_id
    RETURNING r.*
  )
  SELECT c.account_id, c.item_id, c.item_type, c.video_id, c.due_at,
    c.generation, c.phase, c.cycle_started_at, c.expected_flip_at,
    c.expected_end_at, c.start_state, c.last_time_watched, c.last_moved_at,
    c.reads, c.failures, s.auth_key, t.baseline_at, t.stremio_trakt,
    public.watch_destination_list(c.account_id)
  FROM claimed c
  JOIN public.watch_tracking t ON t.account_id = c.account_id
  LEFT JOIN public.stremio_connections s ON s.account_id = c.account_id;
$$;

-- Store the next step of each claimed read. `next_due_at` null deletes it.
-- Only rows still under this lease and generation change.
CREATE FUNCTION public.finish_watch_reads(p_lease_token uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  changed integer := 0;
  n integer;
BEGIN
  DELETE FROM public.watch_reads r
  USING jsonb_to_recordset(p_rows) AS i(
    account_id text, item_id text, generation integer, next_due_at timestamptz
  )
  WHERE i.next_due_at IS NULL
    AND r.account_id = i.account_id AND r.item_id = i.item_id
    AND r.generation = i.generation AND r.lease_token = p_lease_token;
  GET DIAGNOSTICS n = ROW_COUNT;
  changed := changed + n;

  UPDATE public.watch_reads r
  SET due_at = i.next_due_at, phase = i.phase,
    expected_flip_at = i.expected_flip_at, expected_end_at = i.expected_end_at,
    last_time_watched = i.last_time_watched, last_moved_at = i.last_moved_at,
    reads = i.reads, failures = i.failures,
    locked_until = '-infinity', lease_token = NULL
  FROM jsonb_to_recordset(p_rows) AS i(
    account_id text, item_id text, generation integer,
    next_due_at timestamptz, phase text, expected_flip_at timestamptz,
    expected_end_at timestamptz, last_time_watched bigint,
    last_moved_at timestamptz, reads integer, failures integer
  )
  WHERE i.next_due_at IS NOT NULL
    AND r.account_id = i.account_id AND r.item_id = i.item_id
    AND r.generation = i.generation AND r.lease_token = p_lease_token;
  GET DIAGNOSTICS n = ROW_COUNT;
  changed := changed + n;

  -- A restart during the read: give the new generation back its row.
  UPDATE public.watch_reads r
  SET locked_until = '-infinity', lease_token = NULL
  FROM jsonb_to_recordset(p_rows) AS i(account_id text, item_id text)
  WHERE r.account_id = i.account_id AND r.item_id = i.item_id
    AND r.lease_token = p_lease_token;
  RETURN changed;
END;
$$;

-- Queue writes for new watched titles. A title already waiting for the same
-- Destination is not queued twice, and a Destination turned off meanwhile
-- gets nothing.
CREATE FUNCTION public.queue_watch_writes(p_rows jsonb)
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
  ON CONFLICT (account_id, provider, imdb_id, season, episode) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Claim due writes of one Provider, or of every Provider but that one. A
-- write whose last lease ran out without a finish may have reached the
-- Provider: it counts as uncertain.
CREATE FUNCTION public.claim_watch_writes(
  p_provider text,
  p_exclude boolean,
  p_limit integer,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS SETOF public.watch_writes
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH due AS (
    SELECT w.id FROM public.watch_writes w
    WHERE (CASE WHEN p_exclude THEN w.provider <> p_provider
                ELSE w.provider = p_provider END)
      AND w.due_at <= now() AND w.locked_until <= now()
    ORDER BY w.due_at
    LIMIT greatest(p_limit, 0)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.watch_writes w
  SET locked_until = now() + make_interval(secs => p_lease_seconds),
    lease_token = p_lease_token,
    uncertain = w.uncertain OR w.lease_token IS NOT NULL
  FROM due WHERE w.id = due.id
  RETURNING w.*;
$$;

-- Results of claimed writes: done (deleted, and the Destination shows the
-- title), a retry at `next_due_at`, or given up (deleted, and the
-- Destination shows the error). Only writes still under this lease change.
CREATE FUNCTION public.finish_watch_writes(p_lease_token uuid, p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Successes: the newest title of each Destination.
  UPDATE public.watch_destinations d
  SET last_success_at = now(), last_error = NULL, last_error_at = NULL,
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

-- Give back claimed writes that this run did not start: no attempt counted.
-- With p_delay_seconds, they wait that long, so other writes go first.
CREATE FUNCTION public.release_watch_writes(
  p_lease_token uuid,
  p_ids bigint[],
  p_delay_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.watch_writes
  SET locked_until = '-infinity', lease_token = NULL,
    -- Without a delay a write keeps its place in line.
    due_at = CASE WHEN p_delay_seconds > 0
      THEN greatest(due_at, now() + make_interval(secs => p_delay_seconds))
      ELSE due_at END
  WHERE id = ANY (p_ids) AND lease_token = p_lease_token;
$$;

-- The age of the oldest Simkl write never tried yet, in seconds (0 when
-- none). Retries wait on purpose and do not count.
CREATE FUNCTION public.watch_simkl_backlog()
RETURNS double precision
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(extract(epoch FROM now() - min(w.detected_at)), 0)::double precision
  FROM public.watch_writes w
  WHERE w.provider = 'simkl' AND w.due_at <= now() AND w.attempts = 0;
$$;

-- Reserve up to p_want Simkl slots in the next p_window_seconds at p_rate a
-- second. The fast rate is refused while `slow_until` holds.
CREATE FUNCTION public.take_simkl_slots(
  p_want integer,
  p_rate double precision,
  p_window_seconds double precision
)
RETURNS TABLE (granted integer, first_slot_at timestamptz, rate double precision)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  g public.watch_simkl_gate;
  r double precision;
  start_at timestamptz;
  n integer;
BEGIN
  SELECT * INTO g FROM public.watch_simkl_gate WHERE id = 'simkl' FOR UPDATE;
  r := CASE WHEN g.slow_until > clock_timestamp() THEN least(p_rate, 1)
            ELSE p_rate END;
  start_at := greatest(g.next_slot_at, clock_timestamp());
  n := least(
    greatest(p_want, 0),
    greatest(0, floor(extract(epoch FROM
      clock_timestamp() + make_interval(secs => p_window_seconds) - start_at
    ) * r)::integer)
  );
  UPDATE public.watch_simkl_gate
  SET next_slot_at = start_at + make_interval(secs => n / r)
  WHERE id = 'simkl';
  RETURN QUERY SELECT n, start_at, r;
END;
$$;

-- Give back slots that a run reserved and did not use. With p_slow_seconds,
-- Simkl answered 429: keep the slow rate that long.
CREATE FUNCTION public.return_simkl_slots(
  p_unused integer,
  p_rate double precision,
  p_slow_seconds integer
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.watch_simkl_gate
  SET next_slot_at = greatest(clock_timestamp(),
      next_slot_at - make_interval(secs => greatest(p_unused, 0) / p_rate)),
    slow_until = CASE WHEN p_slow_seconds > 0
      THEN clock_timestamp() + make_interval(secs => p_slow_seconds)
      ELSE slow_until END
  WHERE id = 'simkl';
$$;

-- The sweep minutes to do now: every minute since the last one, at most 30.
CREATE FUNCTION public.claim_sweep_slots(p_now timestamptz)
RETURNS TABLE (slot smallint, slot_at timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  last_at timestamptz;
  target timestamptz := date_trunc('minute', p_now);
BEGIN
  INSERT INTO public.watch_sweep_cursor (id, last_slot_at)
  VALUES ('sweep', target - interval '1 minute')
  ON CONFLICT (id) DO NOTHING;
  SELECT c.last_slot_at INTO last_at FROM public.watch_sweep_cursor c
  WHERE c.id = 'sweep' FOR UPDATE;
  IF last_at >= target THEN RETURN; END IF;
  last_at := greatest(last_at, target - interval '30 minutes');
  UPDATE public.watch_sweep_cursor SET last_slot_at = target WHERE id = 'sweep';
  RETURN QUERY
    SELECT ((extract(epoch FROM t)::bigint / 60) % 360)::smallint, t
    FROM generate_series(last_at + interval '1 minute', target, interval '1 minute') t;
END;
$$;

-- The Accounts of these sweep slots, with what the sweep needs for each.
CREATE FUNCTION public.watch_sweep_accounts(p_slots smallint[])
RETURNS TABLE (
  account_id text, auth_key text, baseline_at timestamptz,
  stremio_trakt boolean, destinations text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT t.account_id, s.auth_key, t.baseline_at, t.stremio_trakt,
    public.watch_destination_list(t.account_id)
  FROM public.watch_tracking t
  JOIN public.stremio_connections s ON s.account_id = t.account_id
  WHERE t.sweep_slot = ANY (p_slots);
$$;

REVOKE ALL ON public.watch_tracking, public.watch_destinations,
  public.watch_reads, public.watch_writes, public.watch_simkl_gate,
  public.watch_sweep_cursor
FROM anon, authenticated;
GRANT ALL ON public.watch_tracking, public.watch_destinations,
  public.watch_reads, public.watch_writes, public.watch_simkl_gate,
  public.watch_sweep_cursor
TO service_role;

REVOKE ALL ON FUNCTION
  public.watch_tracking_drop_empty(),
  public.watch_writes_drop_on_new_user(),
  public.watch_destination_list(text),
  public.watch_context(text),
  public.watch_restart(text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz, timestamptz),
  public.watch_read_soon(text, text),
  public.claim_watch_reads(integer, integer, uuid),
  public.finish_watch_reads(uuid, jsonb),
  public.queue_watch_writes(jsonb),
  public.claim_watch_writes(text, boolean, integer, integer, uuid),
  public.finish_watch_writes(uuid, jsonb),
  public.release_watch_writes(uuid, bigint[], integer),
  public.watch_simkl_backlog(),
  public.take_simkl_slots(integer, double precision, double precision),
  public.return_simkl_slots(integer, double precision, integer),
  public.claim_sweep_slots(timestamptz),
  public.watch_sweep_accounts(smallint[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.watch_destination_list(text),
  public.watch_context(text),
  public.watch_restart(text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz, timestamptz),
  public.watch_read_soon(text, text),
  public.claim_watch_reads(integer, integer, uuid),
  public.finish_watch_reads(uuid, jsonb),
  public.queue_watch_writes(jsonb),
  public.claim_watch_writes(text, boolean, integer, integer, uuid),
  public.finish_watch_writes(uuid, jsonb),
  public.release_watch_writes(uuid, bigint[], integer),
  public.watch_simkl_backlog(),
  public.take_simkl_slots(integer, double precision, double precision),
  public.return_simkl_slots(integer, double precision, integer),
  public.claim_sweep_slots(timestamptz),
  public.watch_sweep_accounts(smallint[])
TO service_role;
