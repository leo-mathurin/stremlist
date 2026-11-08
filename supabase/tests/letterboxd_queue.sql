-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
-- Time is simulated by moving the timestamps of the gate and its waiters.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  r jsonb;
  first_ticket uuid;
  later_ticket uuid;
  other_ticket uuid;
  i integer;
BEGIN
  -- A new gate grants one second of tokens at once, without tickets.
  FOR i IN 1..10 LOOP
    r := public.letterboxd_take_turn(10, 'later', NULL, 'test');
    ASSERT r->>'status' = 'granted' AND (r->>'wait_ms')::int = 0, r::text;
    ASSERT r->'ticket' = 'null'::jsonb, r::text;
  END LOOP;
  -- Then a grant is reserved at most 1 s ahead: ten more slots, 100 ms apart.
  FOR i IN 1..10 LOOP
    r := public.letterboxd_take_turn(10, 'later', NULL, 'test');
    ASSERT r->>'status' = 'granted', r::text;
  END LOOP;
  ASSERT (r->>'wait_ms')::int BETWEEN 900 AND 1010, r::text;
  -- The next later page waits: it gets a ticket, an estimate and a retry time.
  r := public.letterboxd_take_turn(10, 'later', NULL, 'test');
  ASSERT r->>'status' = 'queued', r::text;
  later_ticket := (r->>'ticket')::uuid;
  ASSERT later_ticket IS NOT NULL, r::text;
  ASSERT (r->>'wait_ms')::int BETWEEN 1000 AND 1200, r::text;
  ASSERT (r->>'retry_ms')::int BETWEEN 250 AND 300, r::text;
  -- A second later page waits behind it.
  r := public.letterboxd_take_turn(10, 'later', NULL, 'test');
  other_ticket := (r->>'ticket')::uuid;
  ASSERT (r->>'wait_ms')::int BETWEEN 1100 AND 1300, r::text;

  -- A first page goes before both: it waits only for the reserved second.
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'queued', r::text;
  first_ticket := (r->>'ticket')::uuid;
  ASSERT (r->>'wait_ms')::int BETWEEN 1000 AND 1200, 'A first page does not count later pages: ' || r::text;

  -- 200 ms later two slots are free. Every waiter is due: the first page
  -- goes, then the oldest later page; the newer later page waits.
  UPDATE public.letterboxd_gate
  SET refilled_at = refilled_at - interval '200 milliseconds' WHERE id = 'test';
  UPDATE public.letterboxd_waiters SET due_at = clock_timestamp() WHERE gate = 'test';
  r := public.letterboxd_take_turn(10, 'later', other_ticket, 'test');
  ASSERT r->>'status' = 'queued', 'The newer later page waits: ' || r::text;
  ASSERT (r->>'ticket')::uuid = other_ticket, 'It keeps its ticket';
  UPDATE public.letterboxd_waiters SET due_at = clock_timestamp() WHERE gate = 'test';
  r := public.letterboxd_take_turn(10, 'first', first_ticket, 'test');
  ASSERT r->>'status' = 'granted', r::text;
  r := public.letterboxd_take_turn(10, 'later', later_ticket, 'test');
  ASSERT r->>'status' = 'granted', r::text;
  -- A granted ticket stays for the next page but no longer waits.
  ASSERT NOT (SELECT waiting FROM public.letterboxd_waiters WHERE id = later_ticket);

  -- The next page of the oldest read keeps its place before the newer read.
  UPDATE public.letterboxd_gate
  SET refilled_at = refilled_at - interval '100 milliseconds' WHERE id = 'test';
  UPDATE public.letterboxd_waiters SET due_at = clock_timestamp() WHERE gate = 'test';
  r := public.letterboxd_take_turn(10, 'later', later_ticket, 'test');
  ASSERT r->>'status' = 'granted', 'The oldest read goes first again: ' || r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A waiter that is not back 5 s after it was due stops holding the turn,
  -- and keeps its place until it is 30 s late.
  -- At 1 request/s: one free token, then one slot reserved 1 s ahead.
  PERFORM public.letterboxd_take_turn(1, 'later', NULL, 'test');
  PERFORM public.letterboxd_take_turn(1, 'later', NULL, 'test');
  r := public.letterboxd_take_turn(1, 'later', NULL, 'test');
  later_ticket := (r->>'ticket')::uuid;
  ASSERT r->>'status' = 'queued', r::text;
  UPDATE public.letterboxd_gate
  SET refilled_at = refilled_at - interval '2 seconds' WHERE id = 'test';
  UPDATE public.letterboxd_waiters
  SET due_at = clock_timestamp() - interval '6 seconds' WHERE id = later_ticket;
  r := public.letterboxd_take_turn(1, 'later', NULL, 'test');
  ASSERT r->>'status' = 'granted', 'A late waiter does not block: ' || r::text;
  ASSERT EXISTS (SELECT 1 FROM public.letterboxd_waiters WHERE id = later_ticket);
  UPDATE public.letterboxd_waiters
  SET expires_at = clock_timestamp() - interval '1 second' WHERE id = later_ticket;
  PERFORM public.letterboxd_take_turn(1, 'later', NULL, 'test');
  ASSERT NOT EXISTS (SELECT 1 FROM public.letterboxd_waiters WHERE id = later_ticket),
    'An expired ticket is forgotten';
  -- An unknown ticket is a new waiter, at the end of its lane.
  r := public.letterboxd_take_turn(1, 'later', later_ticket, 'test');
  ASSERT r->>'status' = 'queued' AND (r->>'ticket')::uuid <> later_ticket, r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A background read takes only a free token, never with a waiter due, and
  -- gets no ticket.
  r := public.letterboxd_take_turn(2, 'background', NULL, 'test');
  ASSERT r->>'status' = 'granted', r::text;
  PERFORM public.letterboxd_take_turn(2, 'later', NULL, 'test');
  r := public.letterboxd_take_turn(2, 'background', NULL, 'test');
  ASSERT r->>'status' = 'queued' AND r->'ticket' = 'null'::jsonb, r::text;
  FOR i IN 1..3 LOOP
    PERFORM public.letterboxd_take_turn(2, 'later', NULL, 'test');
  END LOOP;
  r := public.letterboxd_take_turn(2, 'later', NULL, 'test');
  ASSERT r->>'status' = 'queued', r::text;
  UPDATE public.letterboxd_gate SET tokens = 2 WHERE id = 'test';
  UPDATE public.letterboxd_waiters SET due_at = clock_timestamp() WHERE gate = 'test';
  r := public.letterboxd_take_turn(2, 'background', NULL, 'test');
  ASSERT r->>'status' = 'queued', 'A background read waits for a due waiter: ' || r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A slowdown pauses every priority; an interactive read keeps a ticket.
  PERFORM public.letterboxd_take_turn(10, 'later', NULL, 'test');
  PERFORM public.letterboxd_report(10, 'rate_limited', 0, false, 'test');
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'paused' AND (r->>'wait_ms')::int > 59000, r::text;
  ASSERT (r->>'retry_ms')::int > 59000 AND r->>'ticket' IS NOT NULL, r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- A halt refuses every priority, except the due probe.
  PERFORM public.letterboxd_take_turn(10, 'later', NULL, 'test');
  PERFORM public.letterboxd_report(10, 'blocked', 0, false, 'test');
  r := public.letterboxd_take_turn(10, 'first', NULL, 'test');
  ASSERT r->>'status' = 'halted', r::text;
  UPDATE public.letterboxd_gate
  SET next_probe_at = clock_timestamp() - interval '1 second' WHERE id = 'test';
  r := public.letterboxd_take_turn(10, 'background', NULL, 'test');
  ASSERT r->>'status' = 'granted' AND (r->>'probe')::boolean, r::text;
  DELETE FROM public.letterboxd_waiters WHERE gate = 'test';
  DELETE FROM public.letterboxd_gate WHERE id = 'test';

  -- An unknown priority is an error.
  BEGIN
    PERFORM public.letterboxd_take_turn(10, 'urgent', NULL, 'test');
    RAISE EXCEPTION 'An unknown priority must fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Unknown Letterboxd priority%' THEN RAISE; END IF;
  END;
END $$;

-- Only the service role may use the queue.
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.letterboxd_take_turn(10, 'first', NULL, 'test');
  RAISE EXCEPTION 'anon must not take Letterboxd turns';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$
BEGIN
  PERFORM 1 FROM public.list_read_queue;
  RAISE EXCEPTION 'anon must not read the list read queue';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;

ROLLBACK;
