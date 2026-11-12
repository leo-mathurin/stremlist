-- SPIKE ONLY (branch spike/watch-tracking-load). Never merge.
-- Watch tracking prototype (ADR 0003): Postgres holds only the due reads, the
-- Destination writes that wait for their turn or a retry, and the Simkl gate.
-- The previous watched state of each Account lives in R2.

-- Accounts with Watch tracking, and their Destinations.
CREATE TABLE public.watch_tracking (
  account_id text PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  destinations text[] NOT NULL,
  -- The minute of the 6-hour sweep cycle (0 to 359) when this Account is swept.
  sweep_slot smallint NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_tracking_sweep_slot ON public.watch_tracking (sweep_slot);
ALTER TABLE public.watch_tracking ENABLE ROW LEVEL SECURITY;

-- One due read per Account and library item.
CREATE TABLE public.watch_reads (
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('movie', 'series')),
  -- The video of the /stream request (`tt…:s:e` for an episode).
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

-- Destination writes waiting for the Simkl gate or for a retry.
CREATE TABLE public.watch_writes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  imdb_id text NOT NULL,
  item_type text NOT NULL,
  season integer,
  episode integer,
  watched_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  first_failed_at timestamptz,
  last_error text,
  locked_until timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid
);
CREATE INDEX watch_writes_due ON public.watch_writes (provider, due_at);
ALTER TABLE public.watch_writes ENABLE ROW LEVEL SECURITY;

-- The global Simkl limiter: slots spaced 1/rate apart (a virtual clock).
CREATE TABLE public.watch_simkl_gate (
  id text PRIMARY KEY,
  next_slot_at timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE public.watch_simkl_gate ENABLE ROW LEVEL SECURITY;
INSERT INTO public.watch_simkl_gate (id) VALUES ('simkl');

-- The last sweep slot done, so a missed minute is caught up.
CREATE TABLE public.watch_sweep_cursor (
  id text PRIMARY KEY,
  last_slot_at timestamptz NOT NULL
);
ALTER TABLE public.watch_sweep_cursor ENABLE ROW LEVEL SECURITY;

-- The Stremio key and Destinations of a tracked Account, for /stream.
CREATE FUNCTION public.watch_context(p_account_id text)
RETURNS TABLE (auth_key text, destinations text[])
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.auth_key, w.destinations
  FROM public.watch_tracking w
  JOIN public.stremio_connections s ON s.account_id = w.account_id
  WHERE w.account_id = p_account_id;
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
  p_last_time_watched bigint,
  p_expected_flip_at timestamptz,
  p_expected_end_at timestamptz,
  p_reads integer
)
RETURNS void
LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO public.watch_reads AS w (
    account_id, item_id, item_type, video_id, due_at, phase, cycle_started_at,
    start_state, last_time_watched, last_moved_at, expected_flip_at,
    expected_end_at, reads
  )
  VALUES (
    p_account_id, p_item_id, p_item_type, p_video_id, p_due_at, p_phase, now(),
    p_start_state, p_last_time_watched, now(), p_expected_flip_at,
    p_expected_end_at, p_reads
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
    reads = w.reads + excluded.reads,
    failures = 0,
    generation = w.generation + 1;
$$;

-- Claim due reads with a lease, with the Stremio key of each Account.
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
  last_moved_at timestamptz, reads integer, failures integer, auth_key text
)
LANGUAGE sql SET search_path = '' AS $$
  WITH due AS (
    SELECT r.account_id, r.item_id
    FROM public.watch_reads r
    WHERE r.due_at <= now() AND r.locked_until <= now()
    ORDER BY r.due_at
    LIMIT p_limit
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
    c.reads, c.failures, s.auth_key
  FROM claimed c
  LEFT JOIN public.stremio_connections s ON s.account_id = c.account_id;
$$;

-- Store the next step of each claimed read. `next_due_at` null deletes it.
-- Only rows still under this lease and generation change.
CREATE FUNCTION public.finish_watch_reads(p_lease_token uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  changed integer := 0;
  n integer;
BEGIN
  WITH input AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      account_id text, item_id text, generation integer,
      next_due_at timestamptz, phase text, expected_flip_at timestamptz,
      expected_end_at timestamptz, last_time_watched bigint,
      last_moved_at timestamptz, reads integer, failures integer
    )
  )
  DELETE FROM public.watch_reads r
  USING input i
  WHERE i.next_due_at IS NULL
    AND r.account_id = i.account_id AND r.item_id = i.item_id
    AND r.generation = i.generation AND r.lease_token = p_lease_token;
  GET DIAGNOSTICS n = ROW_COUNT;
  changed := changed + n;

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      account_id text, item_id text, generation integer,
      next_due_at timestamptz, phase text, expected_flip_at timestamptz,
      expected_end_at timestamptz, last_time_watched bigint,
      last_moved_at timestamptz, reads integer, failures integer
    )
  )
  UPDATE public.watch_reads r
  SET due_at = i.next_due_at, phase = i.phase,
    expected_flip_at = i.expected_flip_at, expected_end_at = i.expected_end_at,
    last_time_watched = i.last_time_watched, last_moved_at = i.last_moved_at,
    reads = i.reads, failures = i.failures,
    locked_until = '-infinity', lease_token = NULL
  FROM input i
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

-- Claim due writes of one Provider (or every Provider but one).
CREATE FUNCTION public.claim_watch_writes(
  p_provider text,
  p_exclude boolean,
  p_limit integer,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS SETOF public.watch_writes
LANGUAGE sql SET search_path = '' AS $$
  WITH due AS (
    SELECT w.id FROM public.watch_writes w
    WHERE (CASE WHEN p_exclude THEN w.provider <> p_provider
                ELSE w.provider = p_provider END)
      AND w.due_at <= now() AND w.locked_until <= now()
    ORDER BY w.due_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.watch_writes w
  SET locked_until = now() + make_interval(secs => p_lease_seconds),
    lease_token = p_lease_token
  FROM due WHERE w.id = due.id
  RETURNING w.*;
$$;

-- Results of claimed writes: done (delete), retry at `next_due_at`, or give up.
CREATE FUNCTION public.finish_watch_writes(p_lease_token uuid, p_rows jsonb)
RETURNS void
LANGUAGE sql SET search_path = '' AS $$
  WITH input AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      id bigint, done boolean, next_due_at timestamptz, error text
    )
  ), removed AS (
    DELETE FROM public.watch_writes w USING input i
    WHERE w.id = i.id AND w.lease_token = p_lease_token
      AND (i.done OR i.next_due_at IS NULL)
    RETURNING w.id
  )
  UPDATE public.watch_writes w
  SET due_at = i.next_due_at, attempts = w.attempts + 1,
    first_failed_at = coalesce(w.first_failed_at, now()),
    last_error = i.error, locked_until = '-infinity', lease_token = NULL
  FROM input i
  WHERE w.id = i.id AND w.lease_token = p_lease_token
    AND NOT i.done AND i.next_due_at IS NOT NULL;
$$;

-- Reserve up to p_want Simkl slots in the next p_window_seconds.
CREATE FUNCTION public.take_simkl_slots(
  p_want integer,
  p_rate double precision,
  p_window_seconds double precision
)
RETURNS TABLE (granted integer, first_slot_at timestamptz)
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  g public.watch_simkl_gate;
  start_at timestamptz;
  n integer;
BEGIN
  SELECT * INTO g FROM public.watch_simkl_gate WHERE id = 'simkl' FOR UPDATE;
  start_at := greatest(g.next_slot_at, clock_timestamp());
  n := least(
    p_want,
    greatest(0, floor(extract(epoch FROM
      clock_timestamp() + make_interval(secs => p_window_seconds) - start_at
    ) * p_rate)::integer)
  );
  UPDATE public.watch_simkl_gate
  SET next_slot_at = start_at + make_interval(secs => n / p_rate)
  WHERE id = 'simkl';
  RETURN QUERY SELECT n, start_at;
END;
$$;

-- Give back slots that a run reserved and did not use.
CREATE FUNCTION public.return_simkl_slots(p_unused integer, p_rate double precision)
RETURNS void
LANGUAGE sql SET search_path = '' AS $$
  UPDATE public.watch_simkl_gate
  SET next_slot_at = greatest(clock_timestamp(),
    next_slot_at - make_interval(secs => p_unused / p_rate))
  WHERE id = 'simkl';
$$;

-- The sweep slots to do now: every minute since the last one, at most 30.
CREATE FUNCTION public.claim_sweep_slots(p_now timestamptz)
RETURNS TABLE (slot smallint, slot_at timestamptz)
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  last_at timestamptz;
  target timestamptz := date_trunc('minute', p_now);
BEGIN
  INSERT INTO public.watch_sweep_cursor (id, last_slot_at)
  VALUES ('sweep', target - interval '1 minute')
  ON CONFLICT (id) DO NOTHING;
  SELECT last_slot_at INTO last_at FROM public.watch_sweep_cursor
  WHERE id = 'sweep' FOR UPDATE;
  IF last_at >= target THEN RETURN; END IF;
  last_at := greatest(last_at, target - interval '30 minutes');
  UPDATE public.watch_sweep_cursor SET last_slot_at = target WHERE id = 'sweep';
  RETURN QUERY
    SELECT ((extract(epoch FROM t)::bigint / 60) % 360)::smallint, t
    FROM generate_series(last_at + interval '1 minute', target, interval '1 minute') t;
END;
$$;

REVOKE ALL ON public.watch_tracking, public.watch_reads, public.watch_writes,
  public.watch_simkl_gate, public.watch_sweep_cursor FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.watch_context(text),
  public.watch_restart(text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz, timestamptz, integer),
  public.claim_watch_reads(integer, integer, uuid),
  public.finish_watch_reads(uuid, jsonb),
  public.claim_watch_writes(text, boolean, integer, integer, uuid),
  public.finish_watch_writes(uuid, jsonb),
  public.take_simkl_slots(integer, double precision, double precision),
  public.return_simkl_slots(integer, double precision),
  public.claim_sweep_slots(timestamptz)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.watch_context(text),
  public.watch_restart(text, text, text, text, timestamptz, text, jsonb, bigint, timestamptz, timestamptz, integer),
  public.claim_watch_reads(integer, integer, uuid),
  public.finish_watch_reads(uuid, jsonb),
  public.claim_watch_writes(text, boolean, integer, integer, uuid),
  public.finish_watch_writes(uuid, jsonb),
  public.take_simkl_slots(integer, double precision, double precision),
  public.return_simkl_slots(integer, double precision),
  public.claim_sweep_slots(timestamptz)
TO service_role;
GRANT ALL ON public.watch_tracking, public.watch_reads, public.watch_writes,
  public.watch_simkl_gate, public.watch_sweep_cursor TO service_role;
