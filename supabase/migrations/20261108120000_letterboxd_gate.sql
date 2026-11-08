-- The shared Letterboxd gate: one token bucket for every backend instance.
-- R2 allows one write per second per object, which capped the previous gate
-- near 0.5 request/s. A row lock here admits many requests per second.
--
-- Rules (docs/letterboxd.md):
-- - The bucket refills at `rate` request/s and holds one second of tokens.
--   Tokens may go negative: a negative balance is future slots already
--   reserved by callers that wait for their turn.
-- - HTTP 429, or more than 20% failed requests over a minute (at least 20),
--   pauses sends for max(Retry-After, 60 s) and halves the rate, never below
--   0.33 request/s. The rate then climbs by 0.5 request/s per minute.
-- - Three slowdowns at the floor rate within 15 minutes, a 403 or a
--   challenge halt every send. A halted gate admits one probe request every
--   30 minutes; a probe that succeeds resumes sends at the floor rate.
-- - The target rate comes from the caller (LETTERBOXD_MAX_RPS), so a new
--   deploy can change it.

CREATE TABLE public.letterboxd_gate (
  id text PRIMARY KEY,
  rate double precision NOT NULL,
  tokens double precision NOT NULL,
  refilled_at timestamptz NOT NULL,
  rate_changed_at timestamptz NOT NULL,
  paused_until timestamptz NOT NULL DEFAULT '-infinity',
  halted_at timestamptz,
  halt_reason text CHECK (halt_reason IN ('blocked', 'rate_limited')),
  next_probe_at timestamptz,
  probe_until timestamptz,
  floor_slowdowns integer NOT NULL DEFAULT 0,
  floor_slowdowns_since timestamptz,
  window_started_at timestamptz NOT NULL,
  window_requests integer NOT NULL DEFAULT 0,
  window_failures integer NOT NULL DEFAULT 0,
  slow_since timestamptz,
  slow_alerted boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.letterboxd_gate IS
  'Shared Letterboxd request gate (token bucket). Reset a halt with: UPDATE public.letterboxd_gate SET halted_at = NULL, halt_reason = NULL, next_probe_at = NULL, probe_until = NULL WHERE id = ''production'';';

ALTER TABLE public.letterboxd_gate ENABLE ROW LEVEL SECURITY;

-- Refill the bucket and climb the rate up to the time t. Pure: the caller
-- stores the result.
CREATE FUNCTION public.letterboxd_gate_settle(
  g public.letterboxd_gate,
  t timestamptz,
  p_target double precision
)
RETURNS public.letterboxd_gate
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  steps integer;
BEGIN
  IF g.rate < p_target AND g.halted_at IS NULL AND t > g.rate_changed_at THEN
    steps := floor(extract(epoch FROM t - g.rate_changed_at) / 60);
    IF steps >= 1 THEN
      g.rate := least(p_target, g.rate + 0.5 * steps);
      g.rate_changed_at := g.rate_changed_at + make_interval(mins => steps);
    END IF;
  END IF;
  IF g.rate > p_target THEN
    g.rate := p_target;
  END IF;
  IF t > g.refilled_at THEN
    g.tokens := least(
      greatest(1, g.rate),
      g.tokens + g.rate * extract(epoch FROM t - g.refilled_at)
    );
    g.refilled_at := t;
  END IF;
  IF g.halted_at IS NULL AND g.rate < 0.5 * p_target THEN
    g.slow_since := coalesce(g.slow_since, t);
  ELSE
    g.slow_since := NULL;
    g.slow_alerted := false;
  END IF;
  RETURN g;
END;
$$;

-- The gate row, created at the target rate with a full bucket.
CREATE FUNCTION public.letterboxd_gate_lock(p_gate text, p_target double precision)
RETURNS public.letterboxd_gate
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  g public.letterboxd_gate;
  t constant timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.letterboxd_gate (
    id, rate, tokens, refilled_at, rate_changed_at, window_started_at
  )
  VALUES (p_gate, p_target, greatest(1, p_target), t, t, t)
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = p_gate FOR UPDATE;
  RETURN g;
END;
$$;

CREATE FUNCTION public.letterboxd_gate_store(g public.letterboxd_gate)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.letterboxd_gate
  SET rate = g.rate,
      tokens = g.tokens,
      refilled_at = g.refilled_at,
      rate_changed_at = g.rate_changed_at,
      paused_until = g.paused_until,
      halted_at = g.halted_at,
      halt_reason = g.halt_reason,
      next_probe_at = g.next_probe_at,
      probe_until = g.probe_until,
      floor_slowdowns = g.floor_slowdowns,
      floor_slowdowns_since = g.floor_slowdowns_since,
      window_started_at = g.window_started_at,
      window_requests = g.window_requests,
      window_failures = g.window_failures,
      slow_since = g.slow_since,
      slow_alerted = g.slow_alerted
  WHERE id = g.id;
$$;

-- Ask for a send slot. Returns {status, wait_ms, probe}:
-- - granted: send after wait_ms (0 when a token was free).
-- - queued: no slot within p_max_wait_ms (or none free now for a background
--   read); wait_ms estimates the wait. Nothing is reserved.
-- - paused: a slowdown is in progress until wait_ms from now.
-- - halted: Letterboxd refused Stremlist; only probes are sent.
CREATE FUNCTION public.letterboxd_take(
  p_target double precision,
  p_max_wait_ms integer,
  p_background boolean,
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
  g public.letterboxd_gate;
  wait_ms double precision;
  result jsonb;
BEGIN
  g := public.letterboxd_gate_settle(
    public.letterboxd_gate_lock(p_gate, target), t, target
  );
  IF g.halted_at IS NOT NULL THEN
    IF g.next_probe_at <= t AND (g.probe_until IS NULL OR g.probe_until <= t) THEN
      g.probe_until := t + interval '1 minute';
      g.next_probe_at := t + interval '30 minutes';
      result := jsonb_build_object('status', 'granted', 'wait_ms', 0, 'probe', true);
    ELSE
      result := jsonb_build_object('status', 'halted', 'wait_ms', 0, 'probe', false);
    END IF;
  ELSIF g.paused_until > t THEN
    result := jsonb_build_object(
      'status', 'paused',
      'wait_ms', ceil(extract(epoch FROM g.paused_until - t) * 1000),
      'probe', false
    );
  ELSIF g.tokens >= 1 THEN
    g.tokens := g.tokens - 1;
    result := jsonb_build_object('status', 'granted', 'wait_ms', 0, 'probe', false);
  ELSE
    wait_ms := ceil((1 - g.tokens) / g.rate * 1000);
    IF p_background OR wait_ms > p_max_wait_ms THEN
      result := jsonb_build_object('status', 'queued', 'wait_ms', wait_ms, 'probe', false);
    ELSE
      g.tokens := g.tokens - 1;
      result := jsonb_build_object('status', 'granted', 'wait_ms', wait_ms, 'probe', false);
    END IF;
  END IF;
  PERFORM public.letterboxd_gate_store(g);
  RETURN result;
END;
$$;

-- Record how a granted request ended: ok, rate_limited (429), blocked (403
-- or challenge) or failed (network error, timeout, 5xx). Returns the edges
-- to alert on: {halted, halt_reason, recovered, slow}.
CREATE FUNCTION public.letterboxd_report(
  p_target double precision,
  p_outcome text,
  p_retry_after_ms integer,
  p_probe boolean,
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
  floor_rate constant double precision := least(0.33, greatest(p_target, 0.01));
  g public.letterboxd_gate;
  was_halted boolean;
  newly_halted boolean := false;
  recovered boolean := false;
  slow boolean := false;
  slow_down boolean := false;
BEGIN
  IF p_outcome NOT IN ('ok', 'rate_limited', 'blocked', 'failed') THEN
    RAISE EXCEPTION 'Unknown Letterboxd outcome: %', p_outcome;
  END IF;
  g := public.letterboxd_gate_settle(
    public.letterboxd_gate_lock(p_gate, target), t, target
  );
  was_halted := g.halted_at IS NOT NULL;

  IF was_halted THEN
    -- Only the probe's result counts while halted; late reports of requests
    -- sent before the halt change nothing.
    IF p_probe THEN
      g.probe_until := NULL;
      IF p_outcome = 'ok' THEN
        g.halted_at := NULL;
        g.halt_reason := NULL;
        g.next_probe_at := NULL;
        g.rate := floor_rate;
        g.rate_changed_at := t;
        g.tokens := 0;
        g.refilled_at := t;
        g.floor_slowdowns := 0;
        g.floor_slowdowns_since := NULL;
        g.window_started_at := t;
        g.window_requests := 0;
        g.window_failures := 0;
        recovered := true;
      ELSE
        g.next_probe_at := t + interval '30 minutes';
      END IF;
    END IF;
  ELSE
    IF t - g.window_started_at >= interval '1 minute' THEN
      g.window_started_at := t;
      g.window_requests := 0;
      g.window_failures := 0;
    END IF;
    g.window_requests := g.window_requests + 1;
    IF p_outcome = 'blocked' THEN
      g.halted_at := t;
      g.halt_reason := 'blocked';
      g.next_probe_at := t + interval '30 minutes';
      newly_halted := true;
    ELSIF p_outcome = 'rate_limited' THEN
      slow_down := true;
    ELSIF p_outcome = 'failed' THEN
      g.window_failures := g.window_failures + 1;
      IF g.window_requests >= 20 AND g.window_failures > 0.2 * g.window_requests THEN
        slow_down := true;
        g.window_started_at := t;
        g.window_requests := 0;
        g.window_failures := 0;
      END IF;
    END IF;

    IF slow_down THEN
      IF g.rate <= floor_rate + 1e-9 THEN
        IF g.floor_slowdowns_since IS NULL
          OR t - g.floor_slowdowns_since > interval '15 minutes' THEN
          g.floor_slowdowns_since := t;
          g.floor_slowdowns := 1;
        ELSE
          g.floor_slowdowns := g.floor_slowdowns + 1;
        END IF;
      END IF;
      IF g.floor_slowdowns >= 3 THEN
        g.halted_at := t;
        g.halt_reason := 'rate_limited';
        g.next_probe_at := t + interval '30 minutes';
        newly_halted := true;
      ELSE
        g.paused_until := greatest(
          g.paused_until,
          t + make_interval(secs => greatest(coalesce(p_retry_after_ms, 0) / 1000.0, 60))
        );
        g.rate := greatest(floor_rate, g.rate / 2);
        g.rate_changed_at := g.paused_until;
        g.tokens := 0;
        g.refilled_at := g.paused_until;
      END IF;
    END IF;
  END IF;

  g := public.letterboxd_gate_settle(g, t, target);
  IF g.slow_since IS NOT NULL
    AND t - g.slow_since >= interval '30 minutes'
    AND NOT g.slow_alerted THEN
    g.slow_alerted := true;
    slow := true;
  END IF;
  PERFORM public.letterboxd_gate_store(g);
  RETURN jsonb_build_object(
    'halted', newly_halted,
    'halt_reason', g.halt_reason,
    'recovered', recovered,
    'slow', slow
  );
END;
$$;

-- Read the gate without changing it: {halted, halt_reason, probe_due,
-- paused_ms, rate, slow_ms}. probe_due: halted, and the next probe may be
-- sent now. A missing row is an open gate at the target rate.
CREATE FUNCTION public.letterboxd_gate_status(
  p_target double precision,
  p_gate text DEFAULT 'production'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  t constant timestamptz := clock_timestamp();
  target constant double precision := greatest(p_target, 0.01);
  g public.letterboxd_gate;
BEGIN
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = p_gate;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'halted', false, 'halt_reason', NULL, 'probe_due', false, 'paused_ms', 0,
      'rate', target, 'slow_ms', 0
    );
  END IF;
  g := public.letterboxd_gate_settle(g, t, target);
  RETURN jsonb_build_object(
    'halted', g.halted_at IS NOT NULL,
    'halt_reason', g.halt_reason,
    'probe_due', g.halted_at IS NOT NULL AND g.next_probe_at <= t
      AND (g.probe_until IS NULL OR g.probe_until <= t),
    'paused_ms', greatest(0, ceil(extract(epoch FROM g.paused_until - t) * 1000)),
    'rate', g.rate,
    'slow_ms', CASE WHEN g.slow_since IS NULL THEN 0
      ELSE floor(extract(epoch FROM t - g.slow_since) * 1000) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.letterboxd_gate_settle(public.letterboxd_gate, timestamptz, double precision)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_gate_lock(text, double precision)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_gate_store(public.letterboxd_gate)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_take(double precision, integer, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_report(double precision, text, integer, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.letterboxd_gate_status(double precision, text)
  FROM PUBLIC, anon, authenticated;
-- The helpers run with the caller's rights inside take and report.
GRANT EXECUTE ON FUNCTION public.letterboxd_gate_settle(public.letterboxd_gate, timestamptz, double precision)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.letterboxd_gate_lock(text, double precision)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.letterboxd_gate_store(public.letterboxd_gate)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.letterboxd_take(double precision, integer, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.letterboxd_report(double precision, text, integer, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.letterboxd_gate_status(double precision, text)
  TO service_role;
