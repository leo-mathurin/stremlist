ALTER TABLE public.user_watchlists
ADD COLUMN IF NOT EXISTS display_mode text NOT NULL DEFAULT 'split'
CHECK (display_mode IN ('split', 'movie', 'series'));
