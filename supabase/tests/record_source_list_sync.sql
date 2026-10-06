-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id) VALUES ('sl_detectiontest0000000000');

DO $$
DECLARE
  acc constant text := 'sl_detectiontest0000000000';
  result integer;
BEGIN
  -- The first complete synchronization is the Baseline: nothing is detected.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['tt1', 'tt2', 'tt2'], '2026-10-01T00:00:00Z');
  ASSERT result = 0, 'The Baseline detects nothing';
  ASSERT (SELECT count(*) FROM public.title_detections
    WHERE account_id = acc AND detected_at IS NULL) = 2,
    'The Baseline keeps each Title once, without a detection date';

  -- The next one detects what it adds, at its own date.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['tt1', 'tt2', 'tt3'], '2026-10-02T00:00:00Z');
  ASSERT result = 1;
  ASSERT (SELECT detected_at FROM public.title_detections
    WHERE account_id = acc AND imdb_id = 'tt3') = '2026-10-02T00:00:00Z';

  -- A removal is a flag, never a deleted row.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['tt1', 'tt2'], '2026-10-03T00:00:00Z');
  ASSERT result = 0;
  ASSERT (SELECT removed_at FROM public.title_detections
    WHERE account_id = acc AND imdb_id = 'tt3') = '2026-10-03T00:00:00Z';

  -- A Title that comes back keeps its first detection.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['tt1', 'tt2', 'tt3'], '2026-10-04T00:00:00Z');
  ASSERT result = 0, 'A Title that comes back is not detected again';
  ASSERT (SELECT row(detected_at, removed_at) FROM public.title_detections
    WHERE account_id = acc AND imdb_id = 'tt3')
    = row('2026-10-02T00:00:00Z'::timestamptz, NULL::timestamptz);

  -- An older synchronization that finishes late changes nothing.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['tt9'], '2026-10-03T12:00:00Z');
  ASSERT result IS NULL, 'An older synchronization is ignored';
  ASSERT NOT EXISTS (SELECT 1 FROM public.title_detections
    WHERE account_id = acc AND imdb_id = 'tt9');
  ASSERT NOT EXISTS (SELECT 1 FROM public.title_detections
    WHERE account_id = acc AND removed_at IS NOT NULL);
  ASSERT (SELECT last_complete_sync_at FROM public.source_list_syncs
    WHERE account_id = acc) = '2026-10-04T00:00:00Z';

  -- Each Source list has its own Baseline.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['tt3', 'tt4'], '2026-10-05T00:00:00Z');
  ASSERT result = 0;

  -- An empty complete synchronization removes everything, but keeps the rows.
  result := public.record_source_list_sync(acc, 'imdb', 'ur1',
    '{}', '2026-10-06T00:00:00Z');
  ASSERT (SELECT count(*) FROM public.title_detections
    WHERE account_id = acc AND provider = 'imdb' AND removed_at IS NULL) = 0;
  ASSERT (SELECT count(*) FROM public.title_detections
    WHERE account_id = acc AND provider = 'imdb') = 3;

  -- Deleting the Account deletes its history.
  DELETE FROM public.accounts WHERE id = acc;
  ASSERT NOT EXISTS (SELECT 1 FROM public.source_list_syncs WHERE account_id = acc);
  ASSERT NOT EXISTS (SELECT 1 FROM public.title_detections WHERE account_id = acc);
END;
$$;

ROLLBACK;
