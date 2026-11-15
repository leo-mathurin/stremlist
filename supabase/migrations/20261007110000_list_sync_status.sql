-- Sync status of each List (STR-58, ADR 0005).
--
-- * `list_sync_status` keeps the outcome of the last refresh of each Source
--   list that a List reads. Rows are keyed by the Source list too, so a List
--   that changes its Source list does not show the status of the old one.
-- * `connections.needs_renewal_since` is set when a Provider refuses a
--   Connection, so the configure page asks the user to connect again.

CREATE TABLE public.list_sync_status (
  list_id uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_ref text NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  last_success_at timestamptz,
  -- Titles in the Catalog after the last successful refresh.
  title_count integer,
  -- A SourceProblemReason, or NULL when the last refresh succeeded.
  failure_reason text,
  -- Start of the current run of failed refreshes.
  failing_since timestamptz,
  PRIMARY KEY (list_id, provider, source_ref)
);
ALTER TABLE public.list_sync_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.connections ADD COLUMN needs_renewal_since timestamptz;

-- Record one refresh outcome. A NULL reason is a success. Returns false when
-- the List no longer exists (it was removed while it was read).
CREATE FUNCTION public.record_list_refresh(
  p_list_id uuid,
  p_provider text,
  p_source_ref text,
  p_failure_reason text,
  p_title_count integer
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  -- One time for the whole outcome, so the attempt, the success and the
  -- start of a failure run are equal when they are the same event.
  WITH outcome AS (
    SELECT clock_timestamp() AS at
  ),
  recorded AS (
    INSERT INTO public.list_sync_status AS s (
      list_id, provider, source_ref, last_attempt_at, last_success_at,
      title_count, failure_reason, failing_since
    )
    SELECT p_list_id, p_provider, p_source_ref, outcome.at,
      CASE WHEN p_failure_reason IS NULL THEN outcome.at END,
      CASE WHEN p_failure_reason IS NULL THEN p_title_count END,
      p_failure_reason,
      CASE WHEN p_failure_reason IS NOT NULL THEN outcome.at END
    FROM public.lists l, outcome
    WHERE l.id = p_list_id
    ON CONFLICT (list_id, provider, source_ref) DO UPDATE SET
      last_attempt_at = EXCLUDED.last_attempt_at,
      last_success_at = coalesce(EXCLUDED.last_success_at, s.last_success_at),
      title_count = CASE WHEN EXCLUDED.failure_reason IS NULL
        THEN EXCLUDED.title_count ELSE s.title_count END,
      failure_reason = EXCLUDED.failure_reason,
      failing_since = CASE WHEN EXCLUDED.failure_reason IS NULL THEN NULL
        ELSE coalesce(s.failing_since, EXCLUDED.failing_since) END
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM recorded);
$$;

REVOKE ALL ON FUNCTION public.record_list_refresh(uuid, text, text, text, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_list_refresh(uuid, text, text, text, integer)
TO service_role;
