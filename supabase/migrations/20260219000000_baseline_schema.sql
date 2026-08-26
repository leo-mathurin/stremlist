-- Baseline for environments created from scratch (local dev, CI).
-- The production database predates migration tracking: `users` and the legacy
-- `watchlist_cache` blob table were created by hand, so the oldest committed
-- migration (20260220000000_enable_rls) assumes they already exist. Everything
-- here is IF NOT EXISTS so pushing this migration to production is a no-op.

CREATE TABLE IF NOT EXISTS public.users (
  imdb_user_id text PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_cache_served_at timestamptz
);

-- Legacy blob cache, unused by the application since watchlist_cache_items.
-- Kept only because later migrations reference it.
CREATE TABLE IF NOT EXISTS public.watchlist_cache (
  imdb_user_id text PRIMARY KEY REFERENCES public.users(imdb_user_id) ON DELETE CASCADE,
  cached_data jsonb,
  cached_at timestamptz NOT NULL DEFAULT now()
);
