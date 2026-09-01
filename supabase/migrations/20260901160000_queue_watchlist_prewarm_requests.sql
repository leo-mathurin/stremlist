ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS prewarm_request_generation bigint NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public.try_acquire_watchlist_prewarm_lease(
  text,
  integer,
  uuid
);
DROP FUNCTION IF EXISTS public.release_watchlist_prewarm_lease(text, uuid);

CREATE FUNCTION public.request_watchlist_prewarm(
  p_owner_user_id text,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH request_time AS (
    SELECT clock_timestamp() AS requested_at
  ),
  requested AS (
    UPDATE public.users
    SET prewarm_request_generation = prewarm_request_generation + 1,
      prewarm_lease_token = CASE
        WHEN prewarm_locked_until <= request_time.requested_at
          THEN p_lease_token
        ELSE prewarm_lease_token
      END,
      prewarm_locked_until = CASE
        WHEN prewarm_locked_until <= request_time.requested_at
          THEN request_time.requested_at
            + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
        ELSE prewarm_locked_until
      END
    FROM request_time
    WHERE imdb_user_id = p_owner_user_id
    RETURNING CASE
      WHEN prewarm_lease_token = p_lease_token
        THEN prewarm_request_generation
      ELSE NULL
    END AS claimed_generation
  )
  SELECT claimed_generation FROM requested;
$$;

CREATE FUNCTION public.finish_watchlist_prewarm(
  p_owner_user_id text,
  p_lease_seconds integer,
  p_lease_token uuid,
  p_completed_generation bigint
)
RETURNS bigint
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH finished AS (
    UPDATE public.users
    SET prewarm_locked_until = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN clock_timestamp()
            + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
        ELSE '1970-01-01 00:00:00+00'::timestamptz
      END,
      prewarm_lease_token = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN prewarm_lease_token
        ELSE NULL
      END
    WHERE imdb_user_id = p_owner_user_id
      AND prewarm_lease_token = p_lease_token
    RETURNING CASE
      WHEN prewarm_request_generation > p_completed_generation
        THEN prewarm_request_generation
      ELSE NULL
    END AS next_generation
  )
  SELECT next_generation FROM finished;
$$;

REVOKE ALL ON FUNCTION public.request_watchlist_prewarm(text, integer, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.request_watchlist_prewarm(text, integer, uuid)
TO service_role;

REVOKE ALL
ON FUNCTION public.finish_watchlist_prewarm(text, integer, uuid, bigint)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.finish_watchlist_prewarm(text, integer, uuid, bigint)
TO service_role;
