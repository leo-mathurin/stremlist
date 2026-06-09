-- Normalised watchlist cache: one row per item instead of one big JSONB blob.
--
-- Why: /meta looks up a single title across all of a user's lists. With the
-- blob cache it had to pull every list's full `cached_data` (avg 182 kB, p95
-- 648 kB) just to scan for one item — ~99% of /meta calls are misses but still
-- paid the full transfer. That fan-out is what doubled Supabase egress. A
-- per-item table lets /meta read one small (~1-3 kB) indexed row instead.
--
-- The old `watchlist_cache` table is intentionally kept in place (unused) as a
-- rollback net; it is dropped in a later migration once egress is confirmed down.

-- The backfill below expands every cached blob into its items and can touch
-- millions of rows; lift the per-statement timeout so it can't be cancelled
-- mid-load (this is what 57014 was — the canceled FK/insert statement).
SET statement_timeout = 0;

-- Create the table with ONLY its primary key. The secondary index and the FK
-- are added AFTER the backfill on purpose: a bulk INSERT into a bare heap pays
-- neither per-row index maintenance nor the per-row RI trigger
-- (`SELECT 1 FROM user_watchlists ... FOR KEY SHARE`) that was timing out.
CREATE TABLE IF NOT EXISTS public.watchlist_cache_items (
  watchlist_id uuid NOT NULL,
  item_id text NOT NULL,
  type text NOT NULL,
  position integer NOT NULL,
  data jsonb NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, item_id)
);

-- Backfill from the existing blobs so deploying this doesn't trigger a mass
-- IMDb re-scrape. The JOIN to user_watchlists guarantees every inserted row has
-- a live parent, so the FK we add afterwards validates cleanly (and there are no
-- orphan blobs to abort on). Assumption: IMDb watchlists are sets (no duplicate
-- `tt` id within a list), so the (watchlist_id, item_id) PK dedupes; ON CONFLICT
-- DO NOTHING guarantees the backfill never aborts on an unexpected duplicate.
INSERT INTO public.watchlist_cache_items (watchlist_id, item_id, type, position, data, cached_at)
SELECT wc.watchlist_id, item->>'id', item->>'type', (ord - 1)::int, item, wc.cached_at
FROM public.watchlist_cache wc
JOIN public.user_watchlists uw ON uw.id = wc.watchlist_id,
  LATERAL jsonb_array_elements(wc.cached_data->'metas') WITH ORDINALITY AS t(item, ord)
ON CONFLICT (watchlist_id, item_id) DO NOTHING;

-- /meta lookup path: WHERE item_id = $1 AND type = $2 AND watchlist_id = ANY($3).
CREATE INDEX IF NOT EXISTS idx_wci_item_lookup
  ON public.watchlist_cache_items (item_id, type);

-- Add the FK last (cascade on parent delete). DROP-then-ADD keeps it idempotent
-- if a previous partial apply already created it.
ALTER TABLE public.watchlist_cache_items
  DROP CONSTRAINT IF EXISTS watchlist_cache_items_watchlist_id_fkey;
ALTER TABLE public.watchlist_cache_items
  ADD CONSTRAINT watchlist_cache_items_watchlist_id_fkey
  FOREIGN KEY (watchlist_id) REFERENCES public.user_watchlists(id) ON DELETE CASCADE;

ALTER TABLE public.watchlist_cache_items ENABLE ROW LEVEL SECURITY;
-- Same RLS posture as watchlist_cache: no anon policy → only the service-role
-- (used by the backend) can read or write.
