-- Runs of the list checks of /monitor (canaries and the alarm on Lists that
-- fail). Better Stack calls /monitor from several regions, and serverless
-- instances share no memory, so the run that may start is claimed here.

CREATE TABLE public.monitor_runs (
  name text PRIMARY KEY,
  -- When the last run started.
  started_at timestamptz NOT NULL,
  -- When the last run that completed ended, and what it found.
  finished_at timestamptz,
  summary jsonb
);
ALTER TABLE public.monitor_runs ENABLE ROW LEVEL SECURITY;

-- Start a run of p_name when the last one started at least
-- p_interval_seconds ago. Only one caller gets true for each interval.
CREATE FUNCTION public.claim_monitor_run(
  p_name text,
  p_interval_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    INSERT INTO public.monitor_runs AS r (name, started_at)
    VALUES (p_name, now())
    ON CONFLICT (name) DO UPDATE SET started_at = EXCLUDED.started_at
    WHERE r.started_at <= now() - make_interval(secs => p_interval_seconds)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.claim_monitor_run(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_monitor_run(text, integer)
  TO service_role;
