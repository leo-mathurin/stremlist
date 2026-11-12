-- SPIKE ONLY (branch spike/watch-tracking-load). Never merge.
-- The tracked Accounts of some sweep slots, with their Stremio key.
CREATE FUNCTION public.watch_sweep_accounts(p_slots smallint[])
RETURNS TABLE (account_id text, destinations text[], auth_key text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT w.account_id, w.destinations, s.auth_key
  FROM public.watch_tracking w
  JOIN public.stremio_connections s ON s.account_id = w.account_id
  WHERE w.sweep_slot = ANY (p_slots);
$$;
REVOKE ALL ON FUNCTION public.watch_sweep_accounts(smallint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.watch_sweep_accounts(smallint[]) TO service_role;
