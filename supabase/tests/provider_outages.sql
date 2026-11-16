-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  r public.provider_outages;
BEGIN
  DELETE FROM public.provider_outages;

  -- One failed probe is not an outage yet.
  r := public.record_provider_probe('trakt', false, 'HTTP 503');
  ASSERT r.failures = 1 AND r.outage_since IS NULL, r::text;
  ASSERT r.last_error = 'HTTP 503', r::text;

  -- The second failed probe in a row starts the outage.
  r := public.record_provider_probe('trakt', false, 'timeout');
  ASSERT r.failures = 2 AND r.outage_since IS NOT NULL, r::text;

  -- More failures keep the start of the outage.
  UPDATE public.provider_outages
  SET outage_since = now() - interval '1 hour' WHERE provider = 'trakt';
  r := public.record_provider_probe('trakt', false, 'timeout');
  ASSERT r.failures = 3, r::text;
  ASSERT r.outage_since <= now() - interval '1 hour', r::text;

  -- Other Providers are independent.
  r := public.record_provider_probe('simkl', false, repeat('x', 900));
  ASSERT r.failures = 1 AND r.outage_since IS NULL, r::text;
  ASSERT length(r.last_error) = 500, 'The error is cut to 500 characters';

  -- A successful probe ends the outage.
  r := public.record_provider_probe('trakt', true);
  ASSERT r.failures = 0 AND r.outage_since IS NULL AND r.last_error IS NULL, r::text;

  -- A failure after a success starts counting again.
  r := public.record_provider_probe('trakt', false, 'HTTP 502');
  ASSERT r.failures = 1 AND r.outage_since IS NULL, r::text;

  -- A threshold of 1 starts the outage at once.
  r := public.record_provider_probe('mdblist', false, 'HTTP 500', 1);
  ASSERT r.outage_since IS NOT NULL, r::text;
END;
$$;

ROLLBACK;

-- The configure page's visitors cannot call the function or read the table.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.record_provider_probe('trakt', false);
    RAISE EXCEPTION 'anon must not record probes';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
ROLLBACK;
