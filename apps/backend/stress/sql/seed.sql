-- Seed :n stress Accounts. run.ts pipes this file to psql with -v n=<count>
-- in one transaction. public.stress_accounts tracks every seeded Account so
-- cleanup.sql can delete them (lists, connections and syncs cascade).
create table public.stress_accounts (
  id text primary key,
  kind text not null,
  legacy text not null
);

-- 70% legacy installs: one IMDb watchlist, reached through /ur…/ URLs.
with ins as (
  insert into public.accounts (legacy_imdb_user_id, is_active)
  select 'ur99' || lpad(g::text, 7, '0'), true
  from generate_series(1, round(:n * 0.7)::int) g
  returning id, legacy_imdb_user_id
)
insert into public.stress_accounts select id, 'legacy', legacy_imdb_user_id from ins;
insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, position)
select id, 'imdb', legacy, 'stress', 'added_at-desc', 0
from public.stress_accounts where kind = 'legacy';

-- 30% private Accounts: an IMDb watchlist, half with "New titles", 30% with
-- a chart and 15% with a merged list.
with ins as (
  insert into public.accounts (is_active, new_titles_catalog)
  select true, g % 2 = 0
  from generate_series(1, :n - round(:n * 0.7)::int) g
  returning id
)
insert into public.stress_accounts
select id, 'private', 'ur98' || lpad((row_number() over ())::text, 7, '0') from ins;
insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, position)
select id, 'imdb', legacy, 'stress', 'added_at-desc', 0
from public.stress_accounts where kind = 'private';
insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, display_mode, position)
select id, 'imdb', 'imdb:most-popular-movies', 'stress chart', 'added_at-asc', 'movie', 1
from public.stress_accounts where kind = 'private' and abs(hashtext(id)) % 10 < 3;
insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, position, merged_sources)
select id, 'imdb', 'ls9' || substr(legacy, 5), 'stress merged', 'title-asc', 2,
  jsonb_build_array(jsonb_build_object('provider', 'imdb', 'source_ref', 'ur97' || substr(legacy, 5)))
from public.stress_accounts where kind = 'private' and abs(hashtext(id)) % 20 < 3;

-- Last line: what k6 opens, one entry per Account (Addon URL key and the
-- catalogs of its Stremio board), in a stable shuffled order.
-- jsonb prints on one line, unlike json_agg.
select coalesce(jsonb_agg(t order by md5(t.key)), '[]')
from (
  select
    case when s.kind = 'legacy' then s.legacy else s.id end as key,
    a.new_titles_catalog as nt,
    json_agg(json_build_object('id', l.id, 'mode', l.display_mode) order by l.position) as lists
  from public.stress_accounts s
  join public.accounts a on a.id = s.id
  join public.lists l on l.account_id = s.id
  group by s.id, s.kind, s.legacy, a.new_titles_catalog
) t;
