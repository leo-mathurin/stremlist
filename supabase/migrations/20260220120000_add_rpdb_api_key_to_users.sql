ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS rpdb_api_key text;
