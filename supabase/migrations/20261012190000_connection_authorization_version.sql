-- Private caches belong to an authorization, not to its rotating tokens.
-- Preserve created_at: same-user renewals keep their detection history.
ALTER TABLE public.connections
  ADD COLUMN authorization_version uuid NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.save_connection(
  p_account_id text,
  p_provider text,
  p_provider_username text,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_scope text,
  p_redirect_uri text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.connections AS c (
    account_id, provider, provider_username, access_token, refresh_token,
    expires_at, scope, redirect_uri, needs_renewal_since, updated_at
  ) VALUES (
    p_account_id, p_provider, p_provider_username, p_access_token,
    p_refresh_token, p_expires_at, p_scope, p_redirect_uri, NULL, now()
  )
  ON CONFLICT (account_id, provider) DO UPDATE SET
    provider_username = EXCLUDED.provider_username,
    access_token = EXCLUDED.access_token,
    refresh_token = EXCLUDED.refresh_token,
    expires_at = EXCLUDED.expires_at,
    scope = EXCLUDED.scope,
    redirect_uri = EXCLUDED.redirect_uri,
    needs_renewal_since = NULL,
    -- The insert default supplies a fresh version on every authorization;
    -- ordinary token refreshes update tokens without changing this version.
    authorization_version = EXCLUDED.authorization_version,
    updated_at = EXCLUDED.updated_at;
END;
$$;
