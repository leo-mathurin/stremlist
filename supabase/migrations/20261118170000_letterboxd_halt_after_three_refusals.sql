-- One refused request (a 403 or a Cloudflare challenge) halted Letterboxd for
-- every Account for 30 minutes. Each refusal so far had a cause that was not a
-- block of Stremlist: a private watchlist, or a member film page that
-- Letterboxd's Cloudflare challenges by itself. A false halt costs more than a
-- slower one, so the gate now halts at the third refusal within 10 minutes.
-- A refusal before that fails only its own read. A probe still halts again
-- at its first refusal.

ALTER TABLE public.letterboxd_gate
  ADD COLUMN blocked_count integer NOT NULL DEFAULT 0,
  ADD COLUMN blocked_since timestamptz;

CREATE OR REPLACE FUNCTION public.letterboxd_gate_store(g public.letterboxd_gate)
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
      slow_alerted = g.slow_alerted,
      blocked_count = g.blocked_count,
      blocked_since = g.blocked_since
  WHERE id = g.id;
$$;

CREATE OR REPLACE FUNCTION public.letterboxd_report(
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
        g.blocked_count := 0;
        g.blocked_since := NULL;
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
    -- A refusal is not part of the failure rate and never checks it: it
    -- cannot slow the gate down.
    IF p_outcome <> 'blocked' THEN
      g.window_requests := g.window_requests + 1;
    END IF;
    IF p_outcome = 'blocked' THEN
      IF g.blocked_since IS NULL
        OR t - g.blocked_since > interval '10 minutes' THEN
        g.blocked_since := t;
        g.blocked_count := 1;
      ELSE
        g.blocked_count := g.blocked_count + 1;
      END IF;
      IF g.blocked_count >= 3 THEN
        g.halted_at := t;
        g.halt_reason := 'blocked';
        g.next_probe_at := t + interval '30 minutes';
        newly_halted := true;
      END IF;
    ELSIF p_outcome = 'rate_limited' THEN
      slow_down := true;
    ELSIF p_outcome = 'failed' THEN
      g.window_failures := g.window_failures + 1;
    END IF;
    -- Checked on every report: failures followed by successes still count.
    IF p_outcome <> 'blocked' AND NOT slow_down
      AND g.window_requests >= 20
      AND g.window_failures > 0.2 * g.window_requests THEN
      slow_down := true;
      g.window_started_at := t;
      g.window_requests := 0;
      g.window_failures := 0;
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
        IF g.rate < 0.5 * target THEN
          g.slow_since := coalesce(g.slow_since, t);
        END IF;
      END IF;
    END IF;
  END IF;

  -- Any halt, also after 429 responses, starts the refusal count again.
  IF newly_halted THEN
    g.blocked_count := 0;
    g.blocked_since := NULL;
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
