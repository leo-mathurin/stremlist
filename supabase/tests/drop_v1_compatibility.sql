-- The contract file applies on the migrated schema and leaves no v1 object.
-- Copy the contract file into the database container first, then run this
-- file with psql -v ON_ERROR_STOP=1 against a migrated local database:
--   docker cp supabase/contract/drop_v1_compatibility.sql <container>:/tmp/
-- The drop is rolled back.
BEGIN;
\i /tmp/drop_v1_compatibility.sql
DO $$
BEGIN
  ASSERT to_regclass('public.users') IS NULL;
  ASSERT to_regclass('public.user_watchlists') IS NULL;
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('replace_user_config',
      'request_watchlist_prewarm', 'finish_watchlist_prewarm',
      'v1_user_watchlists_insert'));
  ASSERT to_regclass('public.accounts') IS NOT NULL;
END;
$$;
ROLLBACK;
