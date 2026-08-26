-- Apply only after the R2 deployment has been verified for one full cache TTL.
-- Keeping this drop in the migration chain makes fresh database replays match
-- the generated TypeScript schema.

DROP TABLE IF EXISTS public.watchlist_cache_items;
DROP TABLE IF EXISTS public.watchlist_cache;
