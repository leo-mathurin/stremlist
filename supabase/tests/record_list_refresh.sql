-- Run with psql -v ON_ERROR_STOP=1 against a migrated local database.
BEGIN;

INSERT INTO public.accounts (id) VALUES ('sl_syncstatustest000000000');
INSERT INTO public.lists (id, account_id, provider, source_ref, catalog_title, position)
VALUES ('55555555-5555-4555-8555-555555555555', 'sl_syncstatustest000000000', 'imdb', 'ur5', 'Five', 0);

DO $$
DECLARE
  target constant uuid := '55555555-5555-4555-8555-555555555555';
  status public.list_sync_status;
  first_failure timestamptz;
BEGIN
  -- A first success stores the time and the Title count.
  ASSERT public.record_list_refresh(target, 'imdb', 'ur5', NULL, 12);
  SELECT * INTO status FROM public.list_sync_status WHERE list_id = target;
  ASSERT status.last_success_at IS NOT NULL AND status.title_count = 12;
  ASSERT status.failure_reason IS NULL AND status.failing_since IS NULL;

  -- Failures keep the last success and its count; the run starts once.
  ASSERT public.record_list_refresh(target, 'imdb', 'ur5', 'private', NULL);
  SELECT * INTO status FROM public.list_sync_status WHERE list_id = target;
  ASSERT status.failure_reason = 'private' AND status.title_count = 12;
  ASSERT status.last_success_at IS NOT NULL AND status.failing_since IS NOT NULL;
  first_failure := status.failing_since;

  ASSERT public.record_list_refresh(target, 'imdb', 'ur5', 'unavailable', NULL);
  SELECT * INTO status FROM public.list_sync_status WHERE list_id = target;
  ASSERT status.failure_reason = 'unavailable', 'The latest reason wins';
  ASSERT status.failing_since = first_failure, 'The failure run keeps its start';
  ASSERT status.last_attempt_at > first_failure;

  -- A success ends the run.
  ASSERT public.record_list_refresh(target, 'imdb', 'ur5', NULL, 0);
  SELECT * INTO status FROM public.list_sync_status WHERE list_id = target;
  ASSERT status.failure_reason IS NULL AND status.failing_since IS NULL;
  ASSERT status.title_count = 0;

  -- Another Source list of the same List gets its own status.
  ASSERT public.record_list_refresh(target, 'imdb', 'imdb:top-rated-movies', 'unavailable', NULL);
  ASSERT (SELECT count(*) FROM public.list_sync_status WHERE list_id = target) = 2;

  -- A removed List records nothing, and its rows go with it.
  ASSERT NOT public.record_list_refresh('66666666-6666-4666-8666-666666666666', 'imdb', 'ur6', NULL, 1);
  DELETE FROM public.lists WHERE id = target;
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_sync_status WHERE list_id = target);
END;
$$;

ROLLBACK;
