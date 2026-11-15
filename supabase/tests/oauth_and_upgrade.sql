-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id, legacy_imdb_user_id)
VALUES ('sl_oauthlegacy000000000000', 'ur7100001');

DO $$
BEGIN
  -- A pending authorization needs the hash of its browser key.
  BEGIN
    INSERT INTO public.oauth_states (state, provider, code_verifier, expires_at)
    VALUES ('no-key', 'trakt', 'verifier', now() + interval '15 minutes');
    RAISE EXCEPTION 'Expected not-null violation';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  -- A new setup starts without an Account.
  INSERT INTO public.oauth_states (
    state, account_id, provider, code_verifier, browser_key_hash, expires_at
  ) VALUES (
    'new-setup', NULL, 'trakt', 'verifier', 'hash', now() + interval '15 minutes'
  );
  ASSERT (SELECT account_id FROM public.oauth_states WHERE state = 'new-setup') IS NULL;

  -- Expired authorizations are deleted on a schedule.
  ASSERT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'oauth-states-expiry'
      AND command LIKE '%DELETE FROM public.oauth_states WHERE expires_at < now()%'
  ), 'oauth-states-expiry job must exist';

  -- The legacy upgrade no longer has a copy that freezes the alias.
  ASSERT to_regprocedure('public.copy_legacy_account(text)') IS NULL,
    'copy_legacy_account must be gone';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name = 'moved_at'
  ), 'accounts.moved_at must be gone';
END;
$$;

ROLLBACK;
