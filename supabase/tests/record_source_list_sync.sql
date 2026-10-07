-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id) VALUES ('sl_detectiontest0000000000');

DO $$
DECLARE
  acc constant text := 'sl_detectiontest0000000000';
  result integer;
  shown jsonb;
BEGIN
  -- The first complete synchronization is the Baseline, Unresolved entries
  -- included: nothing is detected.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'trakt-movie:2', 'trakt-movie:2', 'trakt-movie:9'],
    ARRAY['tt1', NULL, 'tt2', NULL], '2026-10-01T00:00:00Z');
  ASSERT result = 0, 'The Baseline detects nothing';
  ASSERT (SELECT count(*) FROM public.source_list_entries
    WHERE account_id = acc AND detected_at IS NULL) = 3,
    'The Baseline keeps each entry key once, without a detection date';
  ASSERT (SELECT imdb_id FROM public.source_list_entries
    WHERE account_id = acc AND entry_key = 'trakt-movie:2') = 'tt2',
    'A resolved duplicate wins over an unresolved one';

  -- A new entry is detected at its first appearance, even unresolved.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'trakt-movie:2', 'trakt-movie:9', 'trakt-movie:3'],
    ARRAY['tt1', 'tt2', NULL, NULL], '2026-10-02T00:00:00Z');
  ASSERT result = 1;
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_new_titles(acc,
    ARRAY['trakt'], ARRAY['users/leo/watchlist'], 100)),
    'An unresolved new entry has no Title to show yet';

  -- Both resolve later: the Baseline entry is not new, the new one keeps
  -- the date of its first appearance.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'trakt-movie:2', 'trakt-movie:9', 'trakt-movie:3'],
    ARRAY['tt1', 'tt2', 'tt9', 'tt3'], '2026-10-03T00:00:00Z');
  ASSERT result = 0;
  SELECT jsonb_agg(to_jsonb(t)) INTO shown FROM public.list_new_titles(acc,
    ARRAY['trakt'], ARRAY['users/leo/watchlist'], 100) AS t;
  ASSERT shown = '[{"imdb_id":"tt3","provider":"trakt","source_ref":"users/leo/watchlist","detected_at":"2026-10-02T00:00:00+00:00"}]'::jsonb,
    format('Only the new entry is a new Title, got %s', shown);

  -- A removal is a flag; the Title leaves the catalog and comes back with
  -- its first date.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'trakt-movie:2', 'trakt-movie:9'],
    ARRAY['tt1', 'tt2', 'tt9'], '2026-10-04T00:00:00Z');
  ASSERT (SELECT removed_at FROM public.source_list_entries
    WHERE account_id = acc AND entry_key = 'trakt-movie:3') = '2026-10-04T00:00:00Z';
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_new_titles(acc,
    ARRAY['trakt'], ARRAY['users/leo/watchlist'], 100));
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'trakt-movie:2', 'trakt-movie:9', 'trakt-movie:3'],
    ARRAY['tt1', 'tt2', 'tt9', 'tt3'], '2026-10-05T00:00:00Z');
  ASSERT result = 0, 'An entry that comes back is not new again';
  ASSERT (SELECT detected_at FROM public.list_new_titles(acc,
    ARRAY['trakt'], ARRAY['users/leo/watchlist'], 100))
    = '2026-10-02T00:00:00Z';

  -- An entry whose key changed is still the same Title: not new.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'title:the movie:2020', 'trakt-movie:9', 'trakt-movie:3'],
    ARRAY['tt1', 'tt2', 'tt9', 'tt3'], '2026-10-06T00:00:00Z');
  ASSERT result = 1;
  ASSERT (SELECT count(*) FROM public.list_new_titles(acc,
    ARRAY['trakt'], ARRAY['users/leo/watchlist'], 100)) = 1;

  -- An older synchronization that finishes late changes nothing.
  result := public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:7'], ARRAY['tt7'], '2026-10-05T12:00:00Z');
  ASSERT result IS NULL, 'An older synchronization is ignored';
  ASSERT NOT EXISTS (SELECT 1 FROM public.source_list_entries
    WHERE account_id = acc AND entry_key = 'trakt-movie:7');

  -- The same Title in a second Source list shows once, with its earliest
  -- detection.
  PERFORM public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['imdb:tt1'], ARRAY['tt1'], '2026-10-06T00:00:00Z');
  PERFORM public.record_source_list_sync(acc, 'imdb', 'ur1',
    ARRAY['imdb:tt1', 'imdb:tt3', 'imdb:tt8'], ARRAY['tt1', 'tt3', 'tt8'],
    '2026-10-07T00:00:00Z');
  SELECT jsonb_agg(t.imdb_id || '@' || t.source_ref) INTO shown
  FROM public.list_new_titles(acc, ARRAY['trakt', 'imdb'],
    ARRAY['users/leo/watchlist', 'ur1'], 100) AS t;
  ASSERT shown = '["tt8@ur1", "tt3@users/leo/watchlist"]'::jsonb,
    format('Newest first, each Title once, got %s', shown);

  -- Removing a Title from the List that detected it first keeps that date
  -- while another List where it is new still has it.
  PERFORM public.record_source_list_sync(acc, 'trakt', 'users/leo/watchlist',
    ARRAY['trakt-movie:1', 'title:the movie:2020', 'trakt-movie:9'],
    ARRAY['tt1', 'tt2', 'tt9'], '2026-10-08T00:00:00Z');
  SELECT jsonb_agg(t.imdb_id || '@' || t.source_ref || '@' || t.detected_at::date) INTO shown
  FROM public.list_new_titles(acc, ARRAY['trakt', 'imdb'],
    ARRAY['users/leo/watchlist', 'ur1'], 100) AS t;
  ASSERT shown = '["tt8@ur1@2026-10-07", "tt3@users/leo/watchlist@2026-10-02"]'::jsonb,
    format('The first date stays, got %s', shown);

  -- A Source list that needs a Connection is written only through the
  -- Connection that read it, and another Provider user starts over.
  ASSERT public.record_source_list_sync(acc, 'trakt', 'me/history',
    ARRAY['trakt-movie:5'], ARRAY['tt5'], '2026-10-08T00:00:00Z', true, 'leo') IS NULL,
    'No Connection, no history';
  INSERT INTO public.connections (account_id, provider, provider_username, access_token, redirect_uri)
  VALUES (acc, 'trakt', 'leo', 'enc', 'https://example.test/callback');
  ASSERT public.record_source_list_sync(acc, 'trakt', 'me/history',
    ARRAY['trakt-movie:5'], ARRAY['tt5'], '2026-10-08T00:00:00Z', true, 'leo') = 0;
  PERFORM public.record_source_list_sync(acc, 'trakt', 'me/history',
    ARRAY['trakt-movie:5', 'trakt-movie:6'], ARRAY['tt5', 'tt6'], '2026-10-09T00:00:00Z', true, 'leo');
  ASSERT public.record_source_list_sync(acc, 'trakt', 'me/history',
    ARRAY['trakt-movie:7'], ARRAY['tt7'], '2026-10-10T00:00:00Z', true, 'someone-else') IS NULL,
    'A read through a replaced Connection is not recorded';
  UPDATE public.connections SET provider_username = 'someone-else'
  WHERE account_id = acc AND provider = 'trakt';
  ASSERT public.record_source_list_sync(acc, 'trakt', 'me/history',
    ARRAY['trakt-movie:7'], ARRAY['tt7'], '2026-10-10T00:00:00Z', true, 'someone-else') = 0,
    'Another Provider user gets a new Baseline';
  ASSERT (SELECT array_agg(entry_key) FROM public.source_list_entries
    WHERE account_id = acc AND source_ref = 'me/history') = ARRAY['trakt-movie:7'];

  -- Mismatched arrays are refused.
  BEGIN
    PERFORM public.record_source_list_sync(acc, 'imdb', 'ur1',
      ARRAY['imdb:tt1'], '{}', '2026-10-08T00:00:00Z');
    RAISE EXCEPTION 'Expected a length check';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Entry keys and IMDb IDs must have the same length' THEN RAISE; END IF;
  END;

  -- Deleting the Account deletes its history.
  DELETE FROM public.accounts WHERE id = acc;
  ASSERT NOT EXISTS (SELECT 1 FROM public.source_list_syncs WHERE account_id = acc);
  ASSERT NOT EXISTS (SELECT 1 FROM public.source_list_entries WHERE account_id = acc);
END;
$$;

ROLLBACK;
