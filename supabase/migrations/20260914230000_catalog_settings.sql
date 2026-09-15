ALTER TABLE public.user_watchlists
  ADD COLUMN IF NOT EXISTS catalog_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
