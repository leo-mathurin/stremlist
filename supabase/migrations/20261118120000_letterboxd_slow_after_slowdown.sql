-- The slow alert ("below half of LETTERBOXD_MAX_RPS for 30 minutes") is for
-- 429 responses or failures that keep the rate low. It also fired after every
-- halt: a probe that works resumes sends at the floor rate, and the climb back
-- to half of 40 request/s takes about 39 minutes. Now only a slowdown starts
-- the slow window. It still ends when the rate is back to half the target.

CREATE OR REPLACE FUNCTION public.letterboxd_gate_settle(
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
  -- letterboxd_report starts the slow window at a slowdown.
  IF g.halted_at IS NOT NULL OR g.rate >= 0.5 * p_target THEN
    g.slow_since := NULL;
    g.slow_alerted := false;
  END IF;
  RETURN g;
END;
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
    END IF;
    -- Checked on every report: failures followed by successes still count.
    IF NOT newly_halted AND NOT slow_down
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
