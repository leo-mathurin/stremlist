-- A fair queue in front of the shared Letterboxd gate (docs/letterboxd.md).
--
-- letterboxd_take reserved a slot up to 10 s ahead or refused the read with
-- nothing reserved. A refused read that tried again went behind every read
-- that arrived meanwhile, and the later pages of big lists went before the
-- first page of a new list. letterboxd_take_turn replaces it:
--
-- - Three priorities: the first page of an interactive read, the later pages
--   of an interactive read, then background reads. A grant is reserved at
--   most 1 s ahead, so a first page never waits behind more than 1 s of
--   later pages.
-- - A read that must wait gets a ticket: a place in its lane, kept while the
--   caller comes back on time (retry_ms), across retries and across the
--   pages of the read. A waiter that is due holds its turn against the
--   waiters behind it. A waiter more than 5 s late stops holding the turn of
--   the others, and its ticket is forgotten 30 s after it was due.
-- - wait_ms estimates when the read will be sent.
--
-- letterboxd_take stays for the backend instances that still call it during
-- a deploy. It uses the same bucket, so the rate holds. Drop it in a later
-- migration.

CREATE TABLE public.letterboxd_waiters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate text NOT NULL,
  -- The order of the queue, in each lane.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  -- 0: the first page of an interactive read. 1: its later pages.
  lane smallint NOT NULL CHECK (lane IN (0, 1)),
  -- False after a grant: the ticket keeps its place for the next page.
  waiting boolean NOT NULL,
  -- When the waiter comes back to ask again.
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX letterboxd_waiters_queue
  ON public.letterboxd_waiters (gate, lane, seq) WHERE waiting;
CREATE INDEX letterboxd_waiters_expiry
  ON public.letterboxd_waiters (gate, expires_at);
ALTER TABLE public.letterboxd_waiters ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.letterboxd_waiters IS
  'Reads waiting for the shared Letterboxd gate, in order (letterboxd_take_turn).';

-- Ask for a send slot. p_priority is first, later or background. p_ticket
-- is the ticket of an earlier answer, or NULL. Returns {status, wait_ms,
-- retry_ms, probe, ticket}:
-- - granted: send after wait_ms (at most 1 s).
-- - queued: ask again after retry_ms with the ticket; wait_ms estimates when
--   the read will be sent. A background read gets no ticket: it does not
--   wait.
-- - paused: a slowdown is in progress until wait_ms from now.
-- - halted: Letterboxd refused Stremlist; only probes are sent.
CREATE FUNCTION public.letterboxd_take_turn(
  p_target double precision,
  p_priority text,
  p_ticket uuid DEFAULT NULL,
  p_gate text DEFAULT 'production'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  t constant timestamptz := clock_timestamp();
  target constant double precision := greatest(p_target, 0.01);
  -- A grant is reserved at most this far ahead, in seconds.
  horizon constant double precision := 1;
  -- A waiter later than this stops holding the turn of the others.
  late constant interval := interval '5 seconds';
  -- A ticket is forgotten this long after its waiter was due.
  grace constant interval := interval '30 seconds';
  g public.letterboxd_gate;
  w public.letterboxd_waiters;
  v_lane smallint;
  v_ticket uuid;
  ahead integer;
  queued integer;
  wait_ms double precision;
  retry_ms double precision;
  result jsonb;
BEGIN
  IF p_priority NOT IN ('first', 'later', 'background') THEN
    RAISE EXCEPTION 'Unknown Letterboxd priority: %', p_priority;
  END IF;
  g := public.letterboxd_gate_settle(
    public.letterboxd_gate_lock(p_gate, target), t, target
  );
  DELETE FROM public.letterboxd_waiters
  WHERE gate = p_gate AND expires_at <= t;
  IF p_ticket IS NOT NULL AND p_priority <> 'background' THEN
    SELECT * INTO w FROM public.letterboxd_waiters
    WHERE id = p_ticket AND gate = p_gate;
  END IF;
  v_ticket := w.id;
  v_lane := CASE p_priority WHEN 'first' THEN 0 ELSE 1 END;

  IF g.halted_at IS NOT NULL THEN
    IF g.next_probe_at <= t AND (g.probe_until IS NULL OR g.probe_until <= t) THEN
      g.probe_until := t + interval '1 minute';
      g.next_probe_at := t + interval '30 minutes';
      result := jsonb_build_object('status', 'granted', 'wait_ms', 0, 'probe', true);
    ELSE
      result := jsonb_build_object('status', 'halted', 'wait_ms', 0, 'probe', false);
    END IF;
  ELSIF g.paused_until > t THEN
    wait_ms := ceil(extract(epoch FROM g.paused_until - t) * 1000);
    retry_ms := wait_ms;
    result := jsonb_build_object('status', 'paused', 'wait_ms', wait_ms, 'probe', false);
  ELSIF p_priority = 'background' THEN
    -- Only a free token, and only when no waiter is due: a background read
    -- never goes before someone who waits.
    IF g.tokens >= 1 AND NOT EXISTS (
      SELECT 1 FROM public.letterboxd_waiters
      WHERE gate = p_gate AND waiting
        AND due_at <= t + make_interval(secs => horizon) AND due_at > t - late
    ) THEN
      g.tokens := g.tokens - 1;
      result := jsonb_build_object('status', 'granted', 'wait_ms', 0, 'probe', false);
    ELSE
      SELECT count(*) INTO queued FROM public.letterboxd_waiters
      WHERE gate = p_gate AND waiting;
      wait_ms := ceil(greatest(queued + 1 - g.tokens, 1) / g.rate * 1000);
      result := jsonb_build_object('status', 'queued', 'wait_ms', wait_ms, 'probe', false);
    END IF;
  ELSE
    -- The waiters that go first and are due now.
    SELECT count(*) INTO ahead FROM public.letterboxd_waiters
    WHERE gate = p_gate AND waiting AND id IS DISTINCT FROM v_ticket
      AND due_at <= t + make_interval(secs => horizon) AND due_at > t - late
      AND (lane < v_lane OR (lane = v_lane AND (v_ticket IS NULL OR seq < w.seq)));
    IF ahead < floor(g.tokens + g.rate * horizon) THEN
      wait_ms := greatest(0, ceil((1 - g.tokens) / g.rate * 1000));
      g.tokens := g.tokens - 1;
      IF v_ticket IS NOT NULL THEN
        UPDATE public.letterboxd_waiters
        SET waiting = false, due_at = t, expires_at = t + interval '1 minute'
        WHERE id = v_ticket;
      END IF;
      result := jsonb_build_object('status', 'granted', 'wait_ms', wait_ms, 'probe', false);
    ELSE
      -- Every live waiter that goes first, due now or later.
      SELECT count(*) INTO queued FROM public.letterboxd_waiters
      WHERE gate = p_gate AND waiting AND id IS DISTINCT FROM v_ticket
        AND (lane < v_lane OR (lane = v_lane AND (v_ticket IS NULL OR seq < w.seq)));
      wait_ms := ceil(greatest(queued + 1 - g.tokens, 1) / g.rate * 1000);
      retry_ms := least(greatest(wait_ms - horizon * 1000, 250), 15000);
      result := jsonb_build_object('status', 'queued', 'wait_ms', wait_ms, 'probe', false);
    END IF;
  END IF;

  -- An interactive read that waits keeps its place in the queue.
  IF retry_ms IS NOT NULL AND p_priority <> 'background' THEN
    IF v_ticket IS NULL THEN
      INSERT INTO public.letterboxd_waiters (gate, lane, waiting, due_at, expires_at)
      VALUES (
        p_gate, v_lane, true,
        t + make_interval(secs => retry_ms / 1000),
        t + make_interval(secs => retry_ms / 1000) + grace
      )
      RETURNING id INTO v_ticket;
    ELSE
      UPDATE public.letterboxd_waiters
      SET lane = v_lane,
          waiting = true,
          due_at = t + make_interval(secs => retry_ms / 1000),
          expires_at = t + make_interval(secs => retry_ms / 1000) + grace
      WHERE id = v_ticket;
    END IF;
    result := result || jsonb_build_object('retry_ms', retry_ms);
  END IF;
  PERFORM public.letterboxd_gate_store(g);
  RETURN result || jsonb_build_object('ticket', v_ticket);
END;
$$;

-- What a List waits for, for the configure page: when the read of one of its
-- Source lists is expected to end. The reader writes it while it waits in a
-- Provider queue and deletes it when the read ends.
CREATE TABLE public.list_read_queue (
  list_id uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_ref text NOT NULL,
  ready_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, provider, source_ref)
);
ALTER TABLE public.list_read_queue ENABLE ROW LEVEL SECURITY;

-- A reader stopped by its function timeout cannot delete its estimate, and
-- the configure page ignores an estimate after 30 s. Delete those every
-- night.
SELECT cron.schedule(
  'list-read-queue-retention',
  '29 3 * * *',
  $$ DELETE FROM public.list_read_queue WHERE updated_at < now() - interval '1 day' $$
);

REVOKE ALL ON TABLE public.letterboxd_waiters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.list_read_queue FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_take_turn(double precision, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.letterboxd_take_turn(double precision, text, uuid, text)
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.letterboxd_waiters TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.list_read_queue TO service_role;
