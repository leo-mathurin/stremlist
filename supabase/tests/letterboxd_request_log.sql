-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  minute_row public.letterboxd_request_minutes;
  rates public.letterboxd_request_rates;
  kept integer;
  failure public.letterboxd_recent_failures;
BEGIN
  DELETE FROM public.letterboxd_request_minutes;
  DELETE FROM public.letterboxd_requests;

  -- A success is counted; it is kept in full only when sampled, without its body.
  PERFORM public.letterboxd_record(jsonb_build_object(
    'outcome', 'ok', 'page_kind', 'collection', 'url', 'https://letterboxd.com/a/watchlist/',
    'status', 200, 'duration_ms', 50, 'wait_ms', 0, 'priority', 'interactive',
    'probe', false, 'body_excerpt', 'not kept'), false);
  PERFORM public.letterboxd_record(jsonb_build_object(
    'outcome', 'ok', 'page_kind', 'film', 'url', 'https://letterboxd.com/film/x/',
    'status', 200, 'duration_ms', 300, 'wait_ms', 400, 'priority', 'background',
    'probe', false, 'cf_cache_status', 'DYNAMIC', 'body_excerpt', 'not kept'), true);
  -- Every failure is kept in full, with the first 2 KB of its body.
  PERFORM public.letterboxd_record(jsonb_build_object(
    'outcome', 'blocked', 'page_kind', 'collection', 'url', 'https://letterboxd.com/b/watchlist/',
    'status', 403, 'duration_ms', 20000, 'wait_ms', 0, 'priority', 'interactive',
    'probe', false, 'cf_mitigated', 'challenge', 'cf_ray', 'abc-FRA',
    'body_excerpt', repeat('x', 5000)), true);

  SELECT * INTO minute_row FROM public.letterboxd_request_minutes WHERE outcome = 'ok';
  ASSERT minute_row.requests = 2 AND minute_row.duration_ms_total = 350, minute_row::text;
  ASSERT minute_row.duration_buckets = ARRAY[1, 0, 1, 0, 0, 0, 0, 0], minute_row::text;
  ASSERT minute_row.wait_ms_total = 400 AND minute_row.duration_ms_max = 300;
  SELECT * INTO minute_row FROM public.letterboxd_request_minutes WHERE outcome = 'blocked';
  ASSERT minute_row.duration_buckets[8] = 1, 'A request over 10 s lands in the last bucket';

  SELECT count(*) INTO kept FROM public.letterboxd_requests;
  ASSERT kept = 2, 'One sampled success and one failure are kept';
  ASSERT (SELECT body_excerpt FROM public.letterboxd_requests WHERE outcome = 'ok') IS NULL,
    'A success never keeps its body';
  ASSERT (SELECT length(body_excerpt) FROM public.letterboxd_requests WHERE outcome = 'blocked') = 2048;

  SELECT * INTO rates FROM public.letterboxd_request_rates;
  ASSERT rates.requests = 3 AND rates.failures = 1 AND rates.blocked = 1, rates::text;
  ASSERT rates.failure_share = 0.333, rates::text;
  ASSERT rates.p50_duration_ms_under = 500, rates::text;
  ASSERT rates.p95_duration_ms_under IS NULL, 'p95 is over 10 s';

  SELECT * INTO failure FROM public.letterboxd_recent_failures;
  ASSERT failure.cf_mitigated = 'challenge' AND failure.cf_ray = 'abc-FRA', failure::text;
END $$;

-- The logs are not readable by the public roles.
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM 1 FROM public.letterboxd_request_rates;
  RAISE EXCEPTION 'anon must not read the Letterboxd request log';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$
BEGIN
  PERFORM public.letterboxd_record('{}'::jsonb, true);
  RAISE EXCEPTION 'anon must not write the Letterboxd request log';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;

-- The retention jobs are scheduled.
RESET ROLE;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname IN (
    'letterboxd-request-log-retention', 'cron-run-details-retention')) = 2;
END $$;

ROLLBACK;
