-- Give :count private stress Accounts a Trakt Connection with Actions on, and
-- give the first one a Trakt watchlist List. run.ts pipes this file to psql
-- with -v count=… -v access=… -v refresh=… (tokens encrypted by encryptSecret).
create temp table stress_trakt on commit drop as
select id from public.stress_accounts where kind = 'private' order by id limit :count;

select count(*) from (
  select public.save_connection(
    p_account_id => id,
    p_provider => 'trakt',
    p_provider_username => 'stress-' || right(id, 6),
    p_access_token => :'access',
    p_refresh_token => :'refresh',
    p_expires_at => now() + interval '30 days',
    p_scope => null,
    p_redirect_uri => 'http://localhost/oauth/trakt/callback'
  )
  from stress_trakt
) saved;

update public.accounts set actions_enabled = true, action_providers = array['trakt']
where id in (select id from stress_trakt);

insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, position)
select id, 'trakt', 'me/watchlist', 'stress trakt', 'added_at-desc', 9
from stress_trakt order by id limit 1;

-- Last line: the Accounts and the Trakt catalog for k6.
select jsonb_build_object(
  'accounts', (select json_agg(id order by id) from stress_trakt),
  'trakt', (
    select json_build_object('key', l.account_id, 'listId', l.id)
    from public.lists l
    where l.provider = 'trakt' and l.account_id in (select id from stress_trakt)
    limit 1
  )
);
