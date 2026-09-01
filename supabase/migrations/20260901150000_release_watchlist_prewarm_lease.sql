ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS prewarm_lease_token uuid;

DROP FUNCTION IF EXISTS public.try_acquire_watchlist_prewarm_lease(text, integer);

CREATE FUNCTION public.try_acquire_watchlist_prewarm_lease(
  p_owner_user_id text,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.users
    SET prewarm_locked_until = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600)),
      prewarm_lease_token = p_lease_token
    WHERE imdb_user_id = p_owner_user_id
      AND prewarm_locked_until <= clock_timestamp()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

CREATE FUNCTION public.release_watchlist_prewarm_lease(
  p_owner_user_id text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH released AS (
    UPDATE public.users
    SET prewarm_locked_until = '1970-01-01 00:00:00+00'::timestamptz,
      prewarm_lease_token = NULL
    WHERE imdb_user_id = p_owner_user_id
      AND prewarm_lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$$;

REVOKE ALL
ON FUNCTION public.try_acquire_watchlist_prewarm_lease(text, integer, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.try_acquire_watchlist_prewarm_lease(text, integer, uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.release_watchlist_prewarm_lease(text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.release_watchlist_prewarm_lease(text, uuid)
TO service_role;
