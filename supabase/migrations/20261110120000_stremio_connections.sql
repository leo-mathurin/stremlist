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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stremio_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stremio_connections FROM anon, authenticated;
