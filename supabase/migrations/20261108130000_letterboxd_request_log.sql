-- The Letterboxd request log: why requests fail, and how they differ from
-- those that do not. Each request is recorded after its read returns:
-- - letterboxd_requests keeps every failed request in full and 1% of the
--   others, with the same fields, so the two can be compared.
-- - letterboxd_request_minutes counts every request per minute and outcome.
-- Both keep 30 days (pg_cron job below).

CREATE TABLE public.letterboxd_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'rate_limited', 'blocked', 'failed')),
  page_kind text NOT NULL CHECK (page_kind IN ('collection', 'film', 'short_link')),
  url text NOT NULL,
  -- Null when no HTTP response arrived (network error, timeout).
  status integer,
  duration_ms integer NOT NULL,
  bytes integer,
  error text,
  cf_ray text,
  cf_mitigated text,
  cf_cache_status text,
  retry_after text,
  server text,
  -- The gate's rate when the request was recorded, and the time it queued.
  rate double precision,
  wait_ms integer NOT NULL,
  priority text NOT NULL CHECK (priority IN ('interactive', 'background')),
  probe boolean NOT NULL,
  region text,
  -- The first 2 KB of the body, for failed requests only.
  body_excerpt text
);
CREATE INDEX letterboxd_requests_at ON public.letterboxd_requests (at);
CREATE INDEX letterboxd_requests_failures
  ON public.letterboxd_requests (at) WHERE outcome <> 'ok';
ALTER TABLE public.letterboxd_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.letterboxd_request_minutes (
  minute timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'rate_limited', 'blocked', 'failed')),
  requests integer NOT NULL,
  duration_ms_total bigint NOT NULL,
  duration_ms_max integer NOT NULL,
  -- Requests by duration, in ms: under 100, 250, 500, 1000, 2500, 5000,
  -- 10000, then longer.
  duration_buckets integer[] NOT NULL,
  wait_ms_total bigint NOT NULL,
  rate_min double precision,
  rate_max double precision,
  PRIMARY KEY (minute, outcome)
);
ALTER TABLE public.letterboxd_request_minutes ENABLE ROW LEVEL SECURITY;

-- Record one request: always in the minute counts, and in full when p_keep
-- (the caller keeps every failure and samples successes).
CREATE FUNCTION public.letterboxd_record(p_request jsonb, p_keep boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_outcome constant text := p_request->>'outcome';
  v_duration constant integer := greatest(0, (p_request->>'duration_ms')::integer);
  v_wait constant integer := greatest(0, coalesce((p_request->>'wait_ms')::integer, 0));
  v_bucket constant integer :=
    width_bucket(v_duration, ARRAY[100, 250, 500, 1000, 2500, 5000, 10000]) + 1;
  v_rate double precision;
  v_buckets integer[] := array_fill(0, ARRAY[8]);
BEGIN
  SELECT rate INTO v_rate FROM public.letterboxd_gate WHERE id = 'production';
  v_buckets[v_bucket] := 1;
  INSERT INTO public.letterboxd_request_minutes AS m (
    minute, outcome, requests, duration_ms_total, duration_ms_max,
    duration_buckets, wait_ms_total, rate_min, rate_max
  )
  VALUES (
    date_trunc('minute', now()), v_outcome, 1, v_duration, v_duration,
    v_buckets, v_wait, v_rate, v_rate
  )
  ON CONFLICT (minute, outcome) DO UPDATE
  SET requests = m.requests + 1,
      duration_ms_total = m.duration_ms_total + v_duration,
      duration_ms_max = greatest(m.duration_ms_max, v_duration),
      duration_buckets[v_bucket] = m.duration_buckets[v_bucket] + 1,
      wait_ms_total = m.wait_ms_total + v_wait,
      rate_min = least(m.rate_min, v_rate),
      rate_max = greatest(m.rate_max, v_rate);

  IF p_keep THEN
    INSERT INTO public.letterboxd_requests (
      outcome, page_kind, url, status, duration_ms, bytes, error, cf_ray,
      cf_mitigated, cf_cache_status, retry_after, server, rate, wait_ms,
      priority, probe, region, body_excerpt
    )
    VALUES (
      v_outcome,
      p_request->>'page_kind',
      p_request->>'url',
      (p_request->>'status')::integer,
      v_duration,
      (p_request->>'bytes')::integer,
      left(p_request->>'error', 500),
      p_request->>'cf_ray',
      p_request->>'cf_mitigated',
      p_request->>'cf_cache_status',
      p_request->>'retry_after',
      p_request->>'server',
      v_rate,
      v_wait,
      p_request->>'priority',
      coalesce((p_request->>'probe')::boolean, false),
      p_request->>'region',
      CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(p_request->>'body_excerpt', 2048) END
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.letterboxd_record(jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.letterboxd_record(jsonb, boolean) TO service_role;

-- One row per minute: requests, failures by kind, durations (p50 and p95
-- read from the duration buckets: the bucket's upper bound) and the rate.
CREATE VIEW public.letterboxd_request_rates
WITH (security_invoker = true) AS
WITH totals AS (
  SELECT
    minute,
    sum(requests) AS requests,
    coalesce(sum(requests) FILTER (WHERE outcome <> 'ok'), 0) AS failures,
    coalesce(sum(requests) FILTER (WHERE outcome = 'rate_limited'), 0) AS rate_limited,
    coalesce(sum(requests) FILTER (WHERE outcome = 'blocked'), 0) AS blocked,
    coalesce(sum(requests) FILTER (WHERE outcome = 'failed'), 0) AS failed,
    round(sum(duration_ms_total)::numeric / sum(requests)) AS avg_duration_ms,
    max(duration_ms_max) AS max_duration_ms,
    round(sum(wait_ms_total)::numeric / sum(requests)) AS avg_wait_ms,
    min(rate_min) AS rate_min,
    max(rate_max) AS rate_max
  FROM public.letterboxd_request_minutes
  GROUP BY minute
),
buckets AS (
  SELECT m.minute, b.position, sum(b.count) AS count
  FROM public.letterboxd_request_minutes m,
    unnest(m.duration_buckets) WITH ORDINALITY AS b(count, position)
  GROUP BY m.minute, b.position
),
cumulative AS (
  SELECT
    minute,
    position,
    sum(count) OVER (PARTITION BY minute ORDER BY position) AS running,
    sum(count) OVER (PARTITION BY minute) AS total
  FROM buckets
),
percentiles AS (
  SELECT
    minute,
    min(position) FILTER (WHERE running >= 0.5 * total) AS p50_position,
    min(position) FILTER (WHERE running >= 0.95 * total) AS p95_position
  FROM cumulative
  GROUP BY minute
)
SELECT
  t.minute,
  t.requests,
  t.failures,
  round(t.failures::numeric / t.requests, 3) AS failure_share,
  t.rate_limited,
  t.blocked,
  t.failed,
  t.avg_duration_ms,
  (ARRAY[100, 250, 500, 1000, 2500, 5000, 10000, NULL])[p.p50_position] AS p50_duration_ms_under,
  (ARRAY[100, 250, 500, 1000, 2500, 5000, 10000, NULL])[p.p95_position] AS p95_duration_ms_under,
  t.max_duration_ms,
  t.avg_wait_ms,
  t.rate_min,
  t.rate_max
FROM totals t
JOIN percentiles p USING (minute);

COMMENT ON VIEW public.letterboxd_request_rates IS
  'Letterboxd requests per minute. pNN_duration_ms_under is the upper bound of the duration bucket holding that percentile (NULL: over 10 s).';

-- The latest failed requests, newest first.
CREATE VIEW public.letterboxd_recent_failures
WITH (security_invoker = true) AS
SELECT
  at, outcome, page_kind, url, status, duration_ms, error, cf_mitigated,
  cf_ray, retry_after, cf_cache_status, rate, wait_ms, priority, probe,
  region, body_excerpt
FROM public.letterboxd_requests
WHERE outcome <> 'ok'
ORDER BY at DESC
LIMIT 200;

REVOKE ALL ON public.letterboxd_requests, public.letterboxd_request_minutes,
  public.letterboxd_request_rates, public.letterboxd_recent_failures
  FROM anon, authenticated;

-- Keep 30 days of logs, and 7 days of pg_cron's own run history, which
-- pg_cron never deletes (https://supabase.com/docs/guides/cron/quickstart).
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'letterboxd-request-log-retention',
  '17 3 * * *',
  $$
    DELETE FROM public.letterboxd_requests WHERE at < now() - interval '30 days';
    DELETE FROM public.letterboxd_request_minutes WHERE minute < now() - interval '30 days';
  $$
);
SELECT cron.schedule(
  'cron-run-details-retention',
  '23 3 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' $$
);
