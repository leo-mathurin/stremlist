ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS prewarm_locked_until timestamptz NOT NULL
DEFAULT '1970-01-01 00:00:00+00'::timestamptz;

CREATE OR REPLACE FUNCTION public.try_acquire_watchlist_prewarm_lease(
  p_owner_user_id text,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.users
    SET prewarm_locked_until = clock_timestamp()
      + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
    WHERE imdb_user_id = p_owner_user_id
      AND prewarm_locked_until <= clock_timestamp()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.try_acquire_watchlist_prewarm_lease(text, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.try_acquire_watchlist_prewarm_lease(text, integer)
TO service_role;
