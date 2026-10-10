-- Merged Lists (STR-59, ADR 0006). `provider` + `source_ref` stay the
-- List's first Source list; `merged_sources` holds the others, in order, as
-- `[{"provider": "trakt", "source_ref": "users/x/watchlist"}, …]`, with an
-- optional "label" (the title of the List it came from, for the configure
-- page only). `source_label` is that label for the first Source list.
-- The backend checks the merge rules.

ALTER TABLE public.lists
  ADD COLUMN merged_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.lists
  ADD CONSTRAINT lists_merged_sources_is_array
  CHECK (jsonb_typeof(merged_sources) = 'array');
ALTER TABLE public.lists ADD COLUMN source_label text;

-- `replace_account_config` learns these columns in
-- 20261007130000_title_detections.sql, where it is created in its final form.
