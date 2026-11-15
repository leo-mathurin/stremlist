-- Step 1 of the upgrade test (supabase/tests/v1_upgrade_check.sql is step 2).
-- Run on a database migrated only to 20260916000000_production_baseline: it
-- writes v1 data the way the v1 backend does, including the kinds of Legacy
-- IDs that production holds and that are not ur + digits.
BEGIN;
SET LOCAL ROLE service_role;

INSERT INTO public.users (imdb_user_id, is_active, last_fetched_at, rpdb_api_key)
VALUES
  ('ur7200001', true, '2026-01-01T00:00:00Z', 'rpdb-1'),
  ('p.upgradehandle', true, '2026-01-02T00:00:00Z', NULL),
  ('ls7200002', false, '2026-01-03T00:00:00Z', NULL),
  ('ur72abc00x9', true, '2026-01-04T00:00:00Z', NULL),
  ('  junk / id  ', true, '2026-01-05T00:00:00Z', NULL);

SELECT public.replace_user_config('ur7200001', 'rpdb-1',
  '[{"imdb_user_id":"ur7200001","catalog_title":"","sort_option":"added_at-asc","display_mode":"split","position":0}]');
INSERT INTO public.user_watchlists (id, owner_user_id, imdb_user_id, catalog_title,
  sort_option, display_mode, position, catalog_settings)
VALUES ('73333333-3333-4333-8333-333333333333', 'ur7200001', 'ls7200009',
  'Picks', 'title-asc', 'movie', 1, '{"minRating":7}');
INSERT INTO public.user_watchlists (owner_user_id, imdb_user_id, catalog_title, sort_option, position)
VALUES
  ('p.upgradehandle', 'p.upgradehandle', '', 'added_at-asc', 0),
  ('  junk / id  ', '  junk / id  ', '', 'added_at-asc', 0);

-- A prewarm lease that is held while the migration runs.
SELECT public.request_watchlist_prewarm('ur7200001', 600,
  '74444444-4444-4444-8444-444444444444');

COMMIT;
