-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
-- Time is simulated by moving the gate's timestamps into the past.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  r jsonb;
  g public.letterboxd_gate;
  i integer;
BEGIN
  -- A new gate starts at the target rate with one second of tokens.
  FOR i IN 1..10 LOOP
    r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
    ASSERT r->>'status' = 'granted' AND (r->>'wait_ms')::int = 0, r::text;
  END LOOP;
  -- The bucket is empty: an interactive read reserves the next slot, about
  -- 100 ms away; a background read is told to come back.
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'granted' AND (r->>'wait_ms')::int BETWEEN 50 AND 110, r::text;
  r := public.letterboxd_take_turn(10, 'background', NULL, 'test');
  ASSERT r->>'status' = 'queued', r::text;
  -- Grants are reserved at most 1 s ahead; past that a read gets a ticket.
  FOR i IN 1..20 LOOP
    r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
    EXIT WHEN r->>'status' = 'queued';
    ASSERT (r->>'wait_ms')::int <= 1000, r::text;
  END LOOP;
  ASSERT r->>'status' = 'queued' AND r->>'ticket' IS NOT NULL, r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A 429 pauses sends for max(Retry-After, 60 s) and halves the rate.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  r := public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  ASSERT NOT (r->>'halted')::boolean, r::text;
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = 'test';
  ASSERT g.rate = 5 AND g.paused_until > clock_timestamp() + interval '59 seconds', g::text;
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'paused' AND (r->>'wait_ms')::int > 59000, r::text;
  r := public.letterboxd_report(10, 'rate_limited', 120000, false, 'test');
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = 'test';
  ASSERT g.rate = 2.5 AND g.paused_until > clock_timestamp() + interval '119 seconds', g::text;

  -- After the pause the rate climbs by 0.5 request/s per minute.
  UPDATE public.letterboxd_gate
  SET paused_until = clock_timestamp() - interval '1 second',
      rate_changed_at = clock_timestamp() - interval '2 minutes 1 second',
      refilled_at = clock_timestamp() - interval '1 second'
  WHERE id = 'test';
  r := public.letterboxd_gate_status(10, 'test');
  ASSERT (r->>'rate')::double precision = 3.5, r::text;
  ASSERT (r->>'paused_ms')::int = 0, r::text;
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'granted', r::text;
  -- A lower target (a new deploy) caps the rate at once.
  r := public.letterboxd_gate_status(2, 'test');
  ASSERT (r->>'rate')::double precision = 2, r::text;
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- The rate never goes below 0.33; three slowdowns there within 15 minutes halt.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  UPDATE public.letterboxd_gate SET rate = 0.4 WHERE id = 'test';
  -- Halving 0.4 stops at the floor; this slowdown was not at the floor yet.
  r := public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  ASSERT (SELECT rate FROM public.letterboxd_gate WHERE id = 'test') = 0.33;
  ASSERT (SELECT floor_slowdowns FROM public.letterboxd_gate WHERE id = 'test') = 0;
  ASSERT NOT (r->>'halted')::boolean, r::text;
  r := public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  ASSERT NOT (r->>'halted')::boolean, r::text;
  r := public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  ASSERT NOT (r->>'halted')::boolean, r::text;
  r := public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  ASSERT (r->>'halted')::boolean AND r->>'halt_reason' = 'rate_limited', r::text;
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'halted', r::text;
  ASSERT (public.letterboxd_gate_status(10, 'test')->>'halted')::boolean;

  ASSERT NOT (public.letterboxd_gate_status(10, 'test')->>'probe_due')::boolean;

  -- A halted gate admits one probe every 30 minutes.
  UPDATE public.letterboxd_gate
  SET next_probe_at = clock_timestamp() - interval '1 second' WHERE id = 'test';
  ASSERT (public.letterboxd_gate_status(10, 'test')->>'probe_due')::boolean;
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'granted' AND (r->>'probe')::boolean, r::text;
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'halted', 'One probe at a time';
  -- A failed probe keeps the halt and waits 30 more minutes.
  r := public.letterboxd_report(10, 'failed', 0, true, 'test');
  ASSERT NOT (r->>'recovered')::boolean, r::text;
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = 'test';
  ASSERT g.halted_at IS NOT NULL AND g.next_probe_at > clock_timestamp() + interval '29 minutes';
  -- A late report of a request sent before the halt changes nothing.
  r := public.letterboxd_report(10, 'ok', 0, false, 'test');
  ASSERT NOT (r->>'recovered')::boolean, r::text;
  -- A probe that works resumes sends at the floor rate.
  UPDATE public.letterboxd_gate
  SET next_probe_at = clock_timestamp() - interval '1 second' WHERE id = 'test';
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT (r->>'probe')::boolean, r::text;
  r := public.letterboxd_report(10, 'ok', 0, true, 'test');
  ASSERT (r->>'recovered')::boolean, r::text;
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = 'test';
  ASSERT g.halted_at IS NULL AND g.rate = 0.33 AND g.floor_slowdowns = 0, g::text;
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A 403 or a challenge halts at once, and reports the edge once.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  r := public.letterboxd_report(10, 'blocked', 0, false, 'test');
  ASSERT (r->>'halted')::boolean AND r->>'halt_reason' = 'blocked', r::text;
  r := public.letterboxd_report(10, 'blocked', 0, false, 'test');
  ASSERT NOT (r->>'halted')::boolean, 'The halt is reported once';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- Failures slow down only above 20% of at least 20 requests in a minute.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  FOR i IN 1..22 LOOP
    PERFORM public.letterboxd_report(10, 'ok', 0, false, 'test');
  END LOOP;
  FOR i IN 1..3 LOOP
    PERFORM public.letterboxd_report(10, 'failed', 0, false, 'test');
  END LOOP;
  ASSERT (SELECT rate FROM public.letterboxd_gate WHERE id = 'test') = 10,
    '3 failures out of 25 do not slow down';
  UPDATE public.letterboxd_gate
  SET window_started_at = clock_timestamp() - interval '61 seconds' WHERE id = 'test';
  FOR i IN 1..19 LOOP
    PERFORM public.letterboxd_report(10, 'failed', 0, false, 'test');
  END LOOP;
  ASSERT (SELECT rate FROM public.letterboxd_gate WHERE id = 'test') = 10,
    'Fewer than 20 requests never slow down';
  PERFORM public.letterboxd_report(10, 'failed', 0, false, 'test');
  SELECT * INTO g FROM public.letterboxd_gate WHERE id = 'test';
  ASSERT g.rate = 5 AND g.paused_until > clock_timestamp(), g::text;
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- Failures followed by successes still slow down: 10 of 20 failed.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  FOR i IN 1..10 LOOP
    PERFORM public.letterboxd_report(10, 'failed', 0, false, 'test');
  END LOOP;
  FOR i IN 1..9 LOOP
    PERFORM public.letterboxd_report(10, 'ok', 0, false, 'test');
  END LOOP;
  ASSERT (SELECT rate FROM public.letterboxd_gate WHERE id = 'test') = 10;
  PERFORM public.letterboxd_report(10, 'ok', 0, false, 'test');
  ASSERT (SELECT rate FROM public.letterboxd_gate WHERE id = 'test') = 5,
    'The 20th report, a success, sees 50% failures';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A rate below half the target for 30 minutes alerts once.
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  UPDATE public.letterboxd_gate
  SET rate = 2,
      rate_changed_at = clock_timestamp(),
      slow_since = clock_timestamp() - interval '31 minutes'
  WHERE id = 'test';
  r := public.letterboxd_report(10, 'ok', 0, false, 'test');
  ASSERT (r->>'slow')::boolean, r::text;
  r := public.letterboxd_report(10, 'ok', 0, false, 'test');
  ASSERT NOT (r->>'slow')::boolean, 'The slow alert fires once';
  ASSERT (public.letterboxd_gate_status(10, 'test')->>'slow_ms')::bigint >= 31 * 60000;
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A missing gate reads as open.
  r := public.letterboxd_gate_status(10, 'test');
  ASSERT NOT (r->>'halted')::boolean AND (r->>'rate')::double precision = 10, r::text;
END $$;

-- Only the service role may use the gate.
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  RAISE EXCEPTION 'anon must not take Letterboxd slots';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;

ROLLBACK;
