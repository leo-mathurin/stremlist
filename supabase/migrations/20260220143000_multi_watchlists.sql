CREATE TABLE IF NOT EXISTS public.user_watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES public.users(imdb_user_id) ON DELETE CASCADE,
  imdb_user_id text NOT NULL,
  catalog_title text NOT NULL,
  sort_option text NOT NULL DEFAULT 'added_at-asc',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, imdb_user_id)
);

ALTER TABLE public.user_watchlists ENABLE ROW LEVEL SECURITY;

INSERT INTO public.user_watchlists (
  owner_user_id,
  imdb_user_id,
  catalog_title,
  sort_option,
  position
)
SELECT
  u.imdb_user_id,
  u.imdb_user_id,
  '',
  'added_at-asc',
  0
FROM public.users u
ON CONFLICT (owner_user_id, imdb_user_id) DO NOTHING;

ALTER TABLE public.watchlist_cache
ADD COLUMN IF NOT EXISTS watchlist_id uuid;

UPDATE public.watchlist_cache wc
SET watchlist_id = uw.id
FROM public.user_watchlists uw
WHERE
  wc.watchlist_id IS NULL
  AND uw.owner_user_id = wc.imdb_user_id
  AND uw.imdb_user_id = wc.imdb_user_id;

ALTER TABLE public.watchlist_cache
DROP CONSTRAINT IF EXISTS watchlist_cache_imdb_user_id_fkey;

ALTER TABLE public.watchlist_cache
DROP CONSTRAINT IF EXISTS watchlist_cache_pkey;

DROP INDEX IF EXISTS public.watchlist_cache_imdb_user_id_key;

ALTER TABLE public.watchlist_cache
ALTER COLUMN watchlist_id SET NOT NULL;

ALTER TABLE public.watchlist_cache
ADD CONSTRAINT watchlist_cache_pkey PRIMARY KEY (watchlist_id);

ALTER TABLE public.watchlist_cache
ADD CONSTRAINT watchlist_cache_watchlist_id_fkey
FOREIGN KEY (watchlist_id) REFERENCES public.user_watchlists(id) ON DELETE CASCADE;

ALTER TABLE public.watchlist_cache
DROP COLUMN IF EXISTS imdb_user_id;
