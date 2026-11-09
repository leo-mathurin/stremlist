-- Contract step of the v2.0.0 release. NOT a migration yet: the Supabase CLI
-- only applies files in supabase/migrations.
--
-- 20261006120000_accounts_providers_connections.sql keeps the v1 shape (the
-- `users` and `user_watchlists` views and the three v1 RPCs), so the v1
-- backend works between `supabase db push` and the promotion of v2. Drop
-- that shape when no deployment of v1 uses the production database:
--
--   1. v2.0.0 serves api.stremlist.com.
--   2. The staging branch has v2.0.0 and its deployment is ready.
--   3. No one uses a preview deployment that is older than v2.0.0.
--
-- Then, in a new pull request, move this file to
-- supabase/migrations/<YYYYMMDDHHMMSS>_drop_v1_compatibility.sql, delete
-- supabase/tests/v1_compatibility.sql, v1_upgrade_seed.sql and
-- v1_upgrade_check.sql and their CI steps, and regenerate the types
-- (`bun run generate:types`).

DROP FUNCTION public.finish_watchlist_prewarm(text, integer, uuid, bigint);
DROP FUNCTION public.request_watchlist_prewarm(text, integer, uuid);
DROP FUNCTION public.replace_user_config(text, text, jsonb);
DROP VIEW public.user_watchlists;
DROP FUNCTION public.v1_user_watchlists_insert();
DROP VIEW public.users;
