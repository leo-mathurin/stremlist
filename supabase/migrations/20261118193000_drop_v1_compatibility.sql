-- Contract step of the v2.0.0 release. 20261006120000_accounts_providers_connections.sql
-- kept the v1 shape (the `users` and `user_watchlists` views and the three v1
-- RPCs), so the v1 backend worked during the release. v2 serves production
-- and staging, and no deployment of v1 uses the database any more.
--
-- After this migration, a rollback to a v1 deployment does not work.

DROP FUNCTION public.finish_watchlist_prewarm(text, integer, uuid, bigint);
DROP FUNCTION public.request_watchlist_prewarm(text, integer, uuid);
DROP FUNCTION public.replace_user_config(text, text, jsonb);
DROP VIEW public.user_watchlists;
DROP FUNCTION public.v1_user_watchlists_insert();
DROP VIEW public.users;
