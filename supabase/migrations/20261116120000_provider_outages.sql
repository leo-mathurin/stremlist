-- Provider outages, as /monitor sees them. Each conclusive probe of a
-- Provider records its result here. A Provider has an outage after
-- p_threshold failed probes in a row; the next successful probe ends it.
-- Inconclusive probes (rate limits, a bad monitor reference, missing
-- configuration) are not recorded, so they neither start nor end an outage.

CREATE TABLE public.provider_outages (
  provider text PRIMARY KEY,
  -- Failed probes in a row; 0 after a successful probe.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- When the outage started, or null when the Provider has none.
  outage_since timestamptz,
  -- The last conclusive probe. The configure page ignores an outage whose
  -- last probe is old: a stopped monitor never leaves a banner forever.
  checked_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
ALTER TABLE public.provider_outages ENABLE ROW LEVEL SECURITY;

-- Record one conclusive probe and answer the Provider's row.
CREATE FUNCTION public.record_provider_probe(
  p_provider text,
  p_ok boolean,
  p_error text DEFAULT NULL,
  p_threshold integer DEFAULT 2
)
RETURNS public.provider_outages
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.provider_outages;
BEGIN
  INSERT INTO public.provider_outages AS o (
    provider, failures, outage_since, checked_at, last_error
  )
  VALUES (
    p_provider,
    CASE WHEN p_ok THEN 0 ELSE 1 END,
    CASE WHEN NOT p_ok AND p_threshold <= 1 THEN now() END,
    now(),
    CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  )
  ON CONFLICT (provider) DO UPDATE
  SET failures = CASE WHEN p_ok THEN 0 ELSE o.failures + 1 END,
      outage_since = CASE
        WHEN p_ok THEN NULL
        WHEN o.outage_since IS NOT NULL THEN o.outage_since
        WHEN o.failures + 1 >= p_threshold THEN now()
      END,
      checked_at = now(),
      last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_probe(text, boolean, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_probe(text, boolean, text, integer)
  TO service_role;
