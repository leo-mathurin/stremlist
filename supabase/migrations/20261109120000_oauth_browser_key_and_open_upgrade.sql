-- Two security fixes.
--
-- 1. An authorization belongs to the browser that started it. The browser
--    keeps a random key; only its SHA-256 hash is stored here, and the
--    callback completes only with the key. A consent link sent to another
--    person therefore links nothing. An authorization for a new setup has no
--    Account yet: the Account is created only when the connection succeeds.
-- 2. A Legacy alias (`ur…`) is public, so nothing done through it may lock
--    the legacy install. The private copy is now an ordinary new Account
--    created from the setup that the legacy configure page shows. The copy
--    function and the "moved" mark are dropped.

-- Pending authorizations from before this change have no browser key; they
-- expire within 15 minutes anyway.
DELETE FROM public.oauth_states;

ALTER TABLE public.oauth_states
  ADD COLUMN browser_key_hash text NOT NULL,
  ALTER COLUMN account_id DROP NOT NULL;

DROP FUNCTION public.copy_legacy_account(text);

ALTER TABLE public.accounts DROP COLUMN moved_at;

-- A connect of a new setup has no Account, so no Account delete removes its
-- pending authorization. Expired ones are deleted every hour.
SELECT cron.schedule(
  'oauth-states-expiry',
  '17 * * * *',
  $$ DELETE FROM public.oauth_states WHERE expires_at < now() $$
);
