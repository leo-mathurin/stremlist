-- Delete every stress Account (lists, connections and syncs cascade). Safe to
-- run when nothing was seeded.
do $$
begin
  if to_regclass('public.stress_accounts') is not null then
    delete from public.accounts where id in (select id from public.stress_accounts);
    drop table public.stress_accounts;
  end if;
end
$$;
