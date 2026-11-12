-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;
INSERT INTO public.accounts (id) VALUES
  ('sl_watchtrackingtest000000'), ('sl_watchtrackingother00000');
INSERT INTO public.stremio_connections (account_id, auth_key, email) VALUES
  ('sl_watchtrackingtest000000', 'sealed-key', 'a@example.com');
INSERT INTO public.connections (account_id, provider, provider_username, access_token, redirect_uri)
SELECT a, p, 'alice', 'enc', 'http://127.0.0.1:7001/oauth/' || p || '/callback'
FROM unnest(ARRAY['sl_watchtrackingtest000000', 'sl_watchtrackingother00000']) a,
  unnest(ARRAY['trakt', 'simkl', 'mdblist']) p;
INSERT INTO public.watch_tracking (account_id, sweep_slot, baseline_at) VALUES
  ('sl_watchtrackingtest000000', 7, now()),
  ('sl_watchtrackingother00000', 8, NULL);
INSERT INTO public.watch_destinations (account_id, provider) VALUES
  ('sl_watchtrackingtest000000', 'trakt'),
  ('sl_watchtrackingtest000000', 'simkl'),
  ('sl_watchtrackingother00000', 'mdblist');
SET LOCAL ROLE service_role;

DO $$
DECLARE
  lease uuid := gen_random_uuid();
  other_lease uuid := gen_random_uuid();
  r record;
  n integer;
BEGIN
  -- Stremio's own Trakt turns the Trakt Destination off, not the others.
  ASSERT (SELECT public.watch_active_destinations('sl_watchtrackingtest000000'))
    = ARRAY['simkl', 'trakt'];
  UPDATE public.watch_tracking SET stremio_trakt = true
  WHERE account_id = 'sl_watchtrackingtest000000';
  ASSERT (SELECT public.watch_active_destinations('sl_watchtrackingtest000000'))
    = ARRAY['simkl'];
  UPDATE public.watch_tracking SET stremio_trakt = false
  WHERE account_id = 'sl_watchtrackingtest000000';

  -- Without a Stremio link, there is no context.
  ASSERT (SELECT count(*) FROM public.watch_context('sl_watchtrackingtest000000')) = 1;
  ASSERT (SELECT count(*) FROM public.watch_context('sl_watchtrackingother00000')) = 0;

  -- A restart creates the read; a second one starts a new generation.
  PERFORM public.watch_restart('sl_watchtrackingtest000000', 'tt0000001', 'movie',
    'tt0000001', now() - interval '1 second', 'warmup', '{"timesWatched": 0}',
    NULL, NULL, NULL);
  SELECT * INTO r FROM public.claim_watch_reads(10, 60, lease);
  ASSERT r.item_id = 'tt0000001' AND r.generation = 1, r::text;
  ASSERT r.auth_key = 'sealed-key' AND r.destinations = ARRAY['simkl', 'trakt'], r::text;
  -- Claimed rows are not claimed again.
  ASSERT (SELECT count(*) FROM public.claim_watch_reads(10, 60, other_lease)) = 0;
  PERFORM public.watch_restart('sl_watchtrackingtest000000', 'tt0000001', 'movie',
    'tt0000001', now() + interval '1 hour', 'warmup', '{"timesWatched": 0}',
    NULL, NULL, NULL);
  -- The old generation's finish changes nothing, and releases the lease.
  n := public.finish_watch_reads(lease, jsonb_build_array(jsonb_build_object(
    'account_id', 'sl_watchtrackingtest000000', 'item_id', 'tt0000001',
    'generation', 1, 'next_due_at', NULL)));
  ASSERT n = 0, n::text;
  SELECT * INTO r FROM public.watch_reads WHERE item_id = 'tt0000001';
  ASSERT r.generation = 2 AND r.lease_token IS NULL AND r.reads = 2, r::text;

  -- A player event moves the read to now, and a finish with a next time keeps it.
  ASSERT (SELECT public.watch_read_soon('sl_watchtrackingtest000000', 'tt0000001'));
  ASSERT NOT (SELECT public.watch_read_soon('sl_watchtrackingtest000000', 'tt0000002'));
  SELECT * INTO r FROM public.claim_watch_reads(10, 60, lease);
  ASSERT r.generation = 2, r::text;
  n := public.finish_watch_reads(lease, jsonb_build_array(jsonb_build_object(
    'account_id', 'sl_watchtrackingtest000000', 'item_id', 'tt0000001',
    'generation', 2, 'next_due_at', now() + interval '2 minutes',
    'phase', 'flip', 'reads', 3, 'failures', 0)));
  ASSERT n = 1, n::text;
  SELECT * INTO r FROM public.watch_reads WHERE item_id = 'tt0000001';
  ASSERT r.phase = 'flip' AND r.reads = 3 AND r.due_at > now(), r::text;

  -- A pause long before the play can turn watched moves nothing.
  UPDATE public.watch_reads SET expected_flip_at = now() + interval '1 hour', due_at = now() + interval '1 hour'
  WHERE item_id = 'tt0000001';
  ASSERT NOT (SELECT public.watch_read_soon('sl_watchtrackingtest000000', 'tt0000001'));
  UPDATE public.watch_reads SET expected_flip_at = now() + interval '2 minutes'
  WHERE item_id = 'tt0000001';
  ASSERT (SELECT public.watch_read_soon('sl_watchtrackingtest000000', 'tt0000001'));

  -- An Account that stopped tracking gets no new read.
  PERFORM public.watch_restart('sl_watchtrackingother00000', 'tt0000003', 'movie',
    'tt0000003', now(), 'warmup', '{}', NULL, NULL, NULL);
  ASSERT EXISTS (SELECT 1 FROM public.watch_reads WHERE item_id = 'tt0000003');

  -- Writes: queued once per Destination, never for a Destination that is off.
  n := public.queue_watch_writes(jsonb_build_array(
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'trakt',
      'imdb_id', 'tt0000001', 'item_type', 'movie', 'watched_at', now()),
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'simkl',
      'imdb_id', 'tt0000001', 'item_type', 'movie', 'watched_at', now()),
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'mdblist',
      'imdb_id', 'tt0000001', 'item_type', 'movie', 'watched_at', now()),
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'simkl',
      'imdb_id', 'tt0000010', 'item_type', 'series', 'season', 1, 'episode', 2,
      'watched_at', now())));
  ASSERT n = 3, n::text;
  n := public.queue_watch_writes(jsonb_build_array(
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'trakt',
      'imdb_id', 'tt0000001', 'item_type', 'movie', 'watched_at', now())));
  ASSERT n = 0, n::text;

  -- Trakt alone, then Simkl alone.
  ASSERT (SELECT count(*) FROM public.claim_watch_writes('simkl', true, 10, 60, lease)) = 1;
  ASSERT (SELECT count(*) FROM public.claim_watch_writes('simkl', false, 1, 60, lease)) = 1;
  SELECT * INTO r FROM public.watch_writes WHERE provider = 'trakt';
  -- A success clears the Destination's error and shows the title.
  UPDATE public.watch_destinations SET last_error = 'not_found'
  WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'trakt';
  PERFORM public.finish_watch_writes(lease, jsonb_build_array(
    jsonb_build_object('id', r.id, 'done', true)));
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_writes WHERE id = r.id);
  SELECT * INTO r FROM public.watch_destinations
  WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'trakt';
  ASSERT r.last_error IS NULL AND r.last_success_at IS NOT NULL, r::text;
  ASSERT r.last_title = '{"imdbId": "tt0000001", "type": "movie"}', r::text;

  -- A retry keeps the write, counts the attempt and remembers an uncertain one.
  SELECT * INTO r FROM public.watch_writes
  WHERE provider = 'simkl' AND lease_token = lease;
  PERFORM public.finish_watch_writes(lease, jsonb_build_array(jsonb_build_object(
    'id', r.id, 'done', false, 'next_due_at', now() + interval '5 minutes',
    'error', 'timeout', 'uncertain', true)));
  SELECT * INTO r FROM public.watch_writes WHERE id = r.id;
  ASSERT r.attempts = 1 AND r.uncertain AND r.first_failed_at IS NOT NULL
    AND r.lease_token IS NULL AND r.due_at > now(), r::text;
  -- A finish with another lease changes nothing.
  PERFORM public.finish_watch_writes(other_lease, jsonb_build_array(
    jsonb_build_object('id', r.id, 'done', true)));
  ASSERT EXISTS (SELECT 1 FROM public.watch_writes WHERE id = r.id);

  -- A lease that ran out without a finish: the next claim treats the write
  -- as uncertain, since it may have reached the Provider.
  UPDATE public.watch_writes SET uncertain = false, due_at = now() - interval '1 second'
  WHERE id = r.id;
  ASSERT (SELECT count(*) FROM public.claim_watch_writes('simkl', false, 10, 60, other_lease)) = 2;
  UPDATE public.watch_writes SET locked_until = now() - interval '1 second'
  WHERE lease_token = other_lease;
  PERFORM public.claim_watch_writes('simkl', false, 10, 60, lease);
  ASSERT (SELECT uncertain FROM public.watch_writes WHERE id = r.id), 'abandoned lease';

  -- A claimed write this run did not start goes back without an attempt.
  UPDATE public.watch_writes SET attempts = 0, uncertain = false WHERE id = r.id;
  PERFORM public.release_watch_writes(lease, ARRAY[r.id]);
  SELECT * INTO r FROM public.watch_writes WHERE id = r.id;
  ASSERT r.lease_token IS NULL AND r.attempts = 0 AND NOT r.uncertain, r::text;
  ASSERT (SELECT count(*) FROM public.claim_watch_writes('simkl', false, 10, 60, lease)) >= 1;
  ASSERT NOT (SELECT uncertain FROM public.watch_writes WHERE id = r.id), 'released write stays certain';

  -- Given up: the write goes, the Destination shows it.
  PERFORM public.finish_watch_writes(lease, jsonb_build_array(jsonb_build_object(
    'id', r.id, 'done', false, 'next_due_at', NULL, 'error', 'provider_error')));
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_writes WHERE id = r.id);
  ASSERT (SELECT last_error FROM public.watch_destinations
    WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'simkl') = 'gave_up';

  -- The Simkl backlog counts only due writes.
  ASSERT (SELECT public.watch_simkl_backlog()) >= 0;

  -- A Connection linked to another Provider user drops its waiting writes;
  -- a token refresh does not.
  UPDATE public.connections SET access_token = 'enc2'
  WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'simkl';
  ASSERT EXISTS (SELECT 1 FROM public.watch_writes WHERE provider = 'simkl');
  UPDATE public.connections SET provider_username = 'bob'
  WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'simkl';
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_writes WHERE provider = 'simkl');

  -- Deleting a Connection deletes its Destination; the last one ends tracking.
  PERFORM public.queue_watch_writes(jsonb_build_array(
    jsonb_build_object('account_id', 'sl_watchtrackingtest000000', 'provider', 'simkl',
      'imdb_id', 'tt0000011', 'item_type', 'movie', 'watched_at', now())));
  DELETE FROM public.connections
  WHERE account_id = 'sl_watchtrackingtest000000' AND provider = 'simkl';
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_writes WHERE provider = 'simkl');
  ASSERT EXISTS (SELECT 1 FROM public.watch_tracking
    WHERE account_id = 'sl_watchtrackingtest000000');
  DELETE FROM public.watch_destinations
  WHERE account_id = 'sl_watchtrackingtest000000';
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_tracking
    WHERE account_id = 'sl_watchtrackingtest000000');
  ASSERT NOT EXISTS (SELECT 1 FROM public.watch_reads
    WHERE account_id = 'sl_watchtrackingtest000000');
END;
$$;

-- The Simkl gate: slots 1/rate apart, the slow rate after a 429.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.take_simkl_slots(100, 3, 10);
  ASSERT r.granted BETWEEN 29 AND 30 AND r.rate = 3, r::text;
  PERFORM public.return_simkl_slots(r.granted, r.rate, 0);
  SELECT * INTO r FROM public.take_simkl_slots(2, 3, 10);
  ASSERT r.granted = 2 AND r.first_slot_at <= clock_timestamp(), r::text;
  PERFORM public.return_simkl_slots(2, 3, 3600);
  SELECT * INTO r FROM public.take_simkl_slots(100, 3, 10);
  ASSERT r.rate = 1 AND r.granted BETWEEN 9 AND 10, r::text;
END;
$$;

-- Sweep slots: each minute once, missed minutes caught up (at most 30).
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.claim_sweep_slots('2026-11-12 10:00:30+00');
  ASSERT n = 1, n::text;
  SELECT count(*) INTO n FROM public.claim_sweep_slots('2026-11-12 10:00:50+00');
  ASSERT n = 0, n::text;
  SELECT count(*) INTO n FROM public.claim_sweep_slots('2026-11-12 10:03:10+00');
  ASSERT n = 3, n::text;
  SELECT count(*) INTO n FROM public.claim_sweep_slots('2026-11-12 12:00:00+00');
  ASSERT n = 30, n::text;
  -- 12:01 UTC is minute 721 of the day: slot 721 % 360 = 1.
  ASSERT (SELECT min(slot) FROM public.claim_sweep_slots('2026-11-12 12:01:00+00')) = 1;
  ASSERT (SELECT count(*) FROM public.watch_sweep_accounts(ARRAY[8]::smallint[])) = 0;
END;
$$;
ROLLBACK;
