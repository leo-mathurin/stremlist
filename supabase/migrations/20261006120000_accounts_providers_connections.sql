-- Multi-provider lists (STR-16).
--
-- * `users` becomes `accounts`. Each Account gets a generated ID that cannot be
--   guessed (ADR 0001). The old IMDb user ID stays as `legacy_imdb_user_id`, the
--   Legacy alias that existing Stremio installs still use in their Addon URL.
-- * `user_watchlists` becomes `lists`. The overloaded `imdb_user_id` column is
--   split into `provider` + `source_ref`. List IDs (and so Catalog IDs) do not
--   change, so installed addons keep working.
-- * New tables: `connections` (OAuth tokens per Account and Provider),
--   `oauth_states` (PKCE verifiers while an authorization is in progress) and
--   `title_id_map` (the ID resolver cache: provider IDs to IMDb IDs).
--
-- Deploy this migration together with the matching backend: the old backend
-- reads `users` and `user_watchlists`.

SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION public.generate_account_id()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  alphabet constant text :=
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  bytes bytea := extensions.gen_random_bytes(22);
  result text := 'sl_';
BEGIN
  -- 22 base62 characters from 22 random bytes. `% 62` has a tiny modulo bias,
  -- which is irrelevant at ~131 bits of entropy.
  FOR i IN 0..21 LOOP
    result := result || substr(alphabet, (get_byte(bytes, i) % 62) + 1, 1);
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_account_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_account_id() TO service_role;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

ALTER TABLE public.users RENAME TO accounts;
ALTER TABLE public.accounts RENAME COLUMN imdb_user_id TO legacy_imdb_user_id;

ALTER TABLE public.accounts ADD COLUMN id text;
UPDATE public.accounts SET id = public.generate_account_id() WHERE id IS NULL;
ALTER TABLE public.accounts ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.accounts ALTER COLUMN id SET DEFAULT public.generate_account_id();

ALTER TABLE public.accounts
  ADD COLUMN moved_at timestamptz,
  ADD COLUMN actions_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN action_providers text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- lists
-- ---------------------------------------------------------------------------

ALTER TABLE public.user_watchlists RENAME TO lists;
ALTER TABLE public.lists RENAME COLUMN imdb_user_id TO source_ref;
ALTER TABLE public.lists ADD COLUMN provider text NOT NULL DEFAULT 'imdb';
ALTER TABLE public.lists ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE public.lists ADD COLUMN account_id text;

UPDATE public.lists l
SET account_id = a.id
FROM public.accounts a
WHERE a.legacy_imdb_user_id = l.owner_user_id;

-- Swap the primary key of accounts from the IMDb ID to the generated ID.
ALTER TABLE public.lists DROP CONSTRAINT IF EXISTS user_watchlists_owner_user_id_fkey;
ALTER TABLE public.lists DROP CONSTRAINT IF EXISTS user_watchlists_owner_user_id_imdb_user_id_key;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS users_pkey;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.accounts ALTER COLUMN legacy_imdb_user_id DROP NOT NULL;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_legacy_imdb_user_id_key UNIQUE (legacy_imdb_user_id);

DELETE FROM public.lists WHERE account_id IS NULL;
ALTER TABLE public.lists ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE public.lists DROP COLUMN owner_user_id;
ALTER TABLE public.lists
  ADD CONSTRAINT lists_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
ALTER TABLE public.lists
  ADD CONSTRAINT lists_account_provider_source_key
  UNIQUE (account_id, provider, source_ref);
ALTER INDEX IF EXISTS public.user_watchlists_pkey RENAME TO lists_pkey;
CREATE INDEX IF NOT EXISTS lists_account_position_idx
  ON public.lists (account_id, position, created_at);

-- ---------------------------------------------------------------------------
-- connections
-- ---------------------------------------------------------------------------

CREATE TABLE public.connections (
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_username text,
  -- AES-256-GCM ciphertexts produced by the backend (CONNECTION_ENCRYPTION_KEY).
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  -- The redirect URI of the authorization. Token refreshes send the same one,
  -- because Trakt checks it there too.
  redirect_uri text NOT NULL,
  refresh_locked_until timestamptz NOT NULL
    DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
  refresh_lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

-- One process at a time may refresh a Connection: Trakt refresh tokens are
-- single-use, and Simkl cancels the previous access token on each refresh.
CREATE FUNCTION public.claim_connection_refresh(
  p_account_id text,
  p_provider text,
  p_lease_seconds integer,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.connections
    SET refresh_locked_until = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 300)),
      refresh_lease_token = p_lease_token
    WHERE account_id = p_account_id
      AND provider = p_provider
      AND refresh_locked_until <= clock_timestamp()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

CREATE FUNCTION public.release_connection_refresh(
  p_account_id text,
  p_provider text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH released AS (
    UPDATE public.connections
    SET refresh_locked_until = '1970-01-01 00:00:00+00'::timestamptz,
      refresh_lease_token = NULL
    WHERE account_id = p_account_id
      AND provider = p_provider
      AND refresh_lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$$;

REVOKE ALL ON FUNCTION public.claim_connection_refresh(text, text, integer, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_connection_refresh(text, text, integer, uuid)
TO service_role;
REVOKE ALL ON FUNCTION public.release_connection_refresh(text, text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_connection_refresh(text, text, uuid)
TO service_role;

CREATE TABLE public.oauth_states (
  state text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- title_id_map: the ID resolver cache (ADR 0002)
-- ---------------------------------------------------------------------------

CREATE TABLE public.title_id_map (
  namespace text NOT NULL,
  external_id text NOT NULL,
  -- NULL means "not resolved yet". Such rows are retried after `retry_after`;
  -- they are never permanent failures.
  imdb_id text,
  strategy text,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  PRIMARY KEY (namespace, external_id)
);
ALTER TABLE public.title_id_map ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RPCs: replace the user_* functions with account-keyed ones
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.replace_user_config(text, text, jsonb);
DROP FUNCTION IF EXISTS public.request_watchlist_prewarm(text, integer, uuid);
DROP FUNCTION IF EXISTS public.finish_watchlist_prewarm(text, integer, uuid, bigint);

CREATE FUNCTION public.replace_account_config(
  p_account_id text,
  p_rpdb_api_key text,
  p_lists jsonb,
  p_actions_enabled boolean,
  p_action_providers text[]
)
RETURNS TABLE (deleted_ids uuid[], lists jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
BEGIN
  -- Serialize replacements, including requests that only create new rows.
  PERFORM 1 FROM public.accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF jsonb_typeof(p_lists) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Lists must be an array';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
    WHERE value ? 'id' AND NOT EXISTS (
      SELECT 1 FROM public.lists l
      WHERE l.id = (value->>'id')::uuid AND l.account_id = p_account_id
    )
  ) THEN
    RAISE EXCEPTION 'List does not belong to this account';
  END IF;

  IF EXISTS (
    SELECT value->>'id' FROM jsonb_array_elements(p_lists) AS entries(value)
    WHERE value ? 'id' GROUP BY value->>'id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate list ID';
  END IF;

  WITH removed AS (
    DELETE FROM public.lists l
    WHERE l.account_id = p_account_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_lists) AS entries(value)
        WHERE (value->>'id')::uuid = l.id
      )
    RETURNING l.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO deleted_ids FROM removed;

  FOR item IN SELECT value FROM jsonb_array_elements(p_lists)
  LOOP
    INSERT INTO public.lists AS l (
      id, account_id, provider, source_ref, catalog_title, sort_option,
      display_mode, position, catalog_settings
    ) VALUES (
      coalesce((item->>'id')::uuid, gen_random_uuid()),
      p_account_id, item->>'provider', item->>'source_ref',
      item->>'catalog_title', item->>'sort_option', item->>'display_mode',
      (item->>'position')::integer, coalesce(item->'catalog_settings', '{}'::jsonb)
    )
    ON CONFLICT (id) DO UPDATE SET
      provider = EXCLUDED.provider,
      source_ref = EXCLUDED.source_ref,
      catalog_title = EXCLUDED.catalog_title,
      sort_option = EXCLUDED.sort_option,
      display_mode = EXCLUDED.display_mode,
      position = EXCLUDED.position,
      -- Omitted settings preserve the locked row, not a client-side snapshot.
      catalog_settings = CASE WHEN item ? 'catalog_settings'
        THEN EXCLUDED.catalog_settings ELSE l.catalog_settings END,
      updated_at = now()
    WHERE l.account_id = p_account_id;
  END LOOP;

  UPDATE public.accounts
  SET rpdb_api_key = p_rpdb_api_key,
    actions_enabled = coalesce(p_actions_enabled, actions_enabled),
    action_providers = coalesce(p_action_providers, action_providers)
  WHERE id = p_account_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.position, l.created_at), '[]'::jsonb)
  INTO lists FROM public.lists l
  WHERE l.account_id = p_account_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_account_config(text, text, jsonb, boolean, text[])
TO service_role;

CREATE FUNCTION public.request_list_prewarm(
  p_account_id text,
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
    UPDATE public.accounts
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
    WHERE id = p_account_id
    RETURNING CASE
      WHEN prewarm_lease_token = p_lease_token
        THEN prewarm_request_generation
      ELSE NULL
    END AS claimed_generation
  )
  SELECT claimed_generation FROM requested;
$$;

CREATE FUNCTION public.finish_list_prewarm(
  p_account_id text,
  p_lease_seconds integer,
  p_lease_token uuid,
  p_completed_generation bigint
)
RETURNS bigint
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH finish_time AS (
    SELECT clock_timestamp() AS finished_at
  ),
  finished AS (
    UPDATE public.accounts
    SET prewarm_locked_until = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN finish_time.finished_at
            + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
        ELSE '1970-01-01 00:00:00+00'::timestamptz
      END,
      prewarm_lease_token = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN prewarm_lease_token
        ELSE NULL
      END
    FROM finish_time
    WHERE id = p_account_id
      AND prewarm_lease_token = p_lease_token
    RETURNING CASE
      WHEN prewarm_request_generation > p_completed_generation
        THEN prewarm_request_generation
      ELSE NULL
    END AS next_generation
  )
  SELECT next_generation FROM finished;
$$;

REVOKE ALL ON FUNCTION public.request_list_prewarm(text, integer, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_list_prewarm(text, integer, uuid)
TO service_role;
REVOKE ALL ON FUNCTION public.finish_list_prewarm(text, integer, uuid, bigint)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_list_prewarm(text, integer, uuid, bigint)
TO service_role;
