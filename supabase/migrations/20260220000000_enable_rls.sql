-- Enable Row Level Security on all tables.
-- The backend uses the service_role key which bypasses RLS automatically.
-- The anon key (used by the frontend) has no permissive policies, so all
-- direct database access from the client is denied by default.

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist_cache ENABLE ROW LEVEL SECURITY;
