-- The Stremio account linked to an Account, so that a save that changes the
-- catalogs updates the installed Stremlist without a reinstall (ADR 0002).
--
-- `auth_key` is a Stremio session key. The backend encrypts it with
-- CONNECTION_ENCRYPTION_KEY (AES-256-GCM) before it reaches this table, and
-- only the backend's service role reads the table: row level security is on
-- and no policy grants anon or authenticated access.
CREATE TABLE public.stremio_connections (
  account_id text PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  auth_key text NOT NULL,
  -- Shown masked on the configure page, to tell which Stremio account it is.
  email text,
  -- One update at a time per Account: each one reads the collection, then
  -- writes it, so two at once could leave Stremio with the older save.
  update_locked_until timestamptz NOT NULL
    DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
  update_lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stremio_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stremio_connections FROM anon, authenticated;

-- 'claimed', 'busy' (another update runs), or 'none' (no link).
CREATE FUNCTION public.claim_stremio_update(
  p_account_id text,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS text
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.stremio_connections
    SET update_locked_until = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 120)),
      update_lease_token = p_lease_token
    WHERE account_id = p_account_id
      AND update_locked_until <= clock_timestamp()
    RETURNING 1
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM claimed) THEN 'claimed'
    WHEN EXISTS (
      SELECT 1 FROM public.stremio_connections WHERE account_id = p_account_id
    ) THEN 'busy'
    ELSE 'none'
  END;
$$;

CREATE FUNCTION public.release_stremio_update(
  p_account_id text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH released AS (
    UPDATE public.stremio_connections
    SET update_locked_until = '1970-01-01 00:00:00+00'::timestamptz,
      update_lease_token = NULL
    WHERE account_id = p_account_id
      AND update_lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$$;

REVOKE ALL ON FUNCTION public.claim_stremio_update(text, integer, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stremio_update(text, integer, uuid)
TO service_role;
REVOKE ALL ON FUNCTION public.release_stremio_update(text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stremio_update(text, uuid)
TO service_role;
