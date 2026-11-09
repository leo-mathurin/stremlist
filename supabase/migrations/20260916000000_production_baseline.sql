-- Production schema on 2026-11-08, dumped from project igbmxubzxjfdbgmawrtr
-- with `supabase db dump --schema public`. It replaces the 12 migrations from
-- 20260219000000_baseline_schema to 20260915080000_replace_user_config.
-- Production already has this schema: its history row was added with
-- `supabase migration repair`, so the deploy never runs this file there.
--
-- Not included: the Letterboxd rate experiments (schemas letterboxd_*_2026*
-- and functions public.letterboxd_*_rpc). They were created by hand, hold only
-- experiment data, and stay in production until dropped.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."finish_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid", "p_completed_generation" bigint) RETURNS bigint
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  WITH finished AS (
    UPDATE public.users
    SET prewarm_locked_until = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN clock_timestamp()
            + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
        ELSE '1970-01-01 00:00:00+00'::timestamptz
      END,
      prewarm_lease_token = CASE
        WHEN prewarm_request_generation > p_completed_generation
          THEN prewarm_lease_token
        ELSE NULL
      END
    WHERE imdb_user_id = p_owner_user_id
      AND prewarm_lease_token = p_lease_token
    RETURNING CASE
      WHEN prewarm_request_generation > p_completed_generation
        THEN prewarm_request_generation
      ELSE NULL
    END AS next_generation
  )
  SELECT next_generation FROM finished;
$$;


ALTER FUNCTION "public"."finish_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid", "p_completed_generation" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_user_config"("p_owner_user_id" "text", "p_rpdb_api_key" "text", "p_watchlists" "jsonb") RETURNS TABLE("deleted_ids" "uuid"[], "watchlists" "jsonb")
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  item jsonb;
BEGIN
  -- Serialize replacements, including requests that only create new rows.
  PERFORM 1 FROM public.users
  WHERE imdb_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF jsonb_typeof(p_watchlists) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Watchlists must be an array';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_watchlists) AS entries(value)
    WHERE value ? 'id' AND NOT EXISTS (
      SELECT 1 FROM public.user_watchlists uw
      WHERE uw.id = (value->>'id')::uuid
        AND uw.owner_user_id = p_owner_user_id
    )
  ) THEN
    RAISE EXCEPTION 'Watchlist does not belong to this user';
  END IF;

  IF EXISTS (
    SELECT value->>'id' FROM jsonb_array_elements(p_watchlists) AS entries(value)
    WHERE value ? 'id' GROUP BY value->>'id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate watchlist ID';
  END IF;

  WITH removed AS (
    DELETE FROM public.user_watchlists uw
    WHERE uw.owner_user_id = p_owner_user_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_watchlists) AS entries(value)
        WHERE (value->>'id')::uuid = uw.id
      )
    RETURNING uw.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO deleted_ids FROM removed;

  FOR item IN SELECT value FROM jsonb_array_elements(p_watchlists)
  LOOP
    INSERT INTO public.user_watchlists AS uw (
      id, owner_user_id, imdb_user_id, catalog_title, sort_option,
      display_mode, position, catalog_settings
    ) VALUES (
      coalesce((item->>'id')::uuid, gen_random_uuid()),
      p_owner_user_id, item->>'imdb_user_id', item->>'catalog_title',
      item->>'sort_option', item->>'display_mode',
      (item->>'position')::integer, coalesce(item->'catalog_settings', '{}'::jsonb)
    )
    ON CONFLICT (id) DO UPDATE SET
      imdb_user_id = EXCLUDED.imdb_user_id,
      catalog_title = EXCLUDED.catalog_title,
      sort_option = EXCLUDED.sort_option,
      display_mode = EXCLUDED.display_mode,
      position = EXCLUDED.position,
      -- Omitted settings preserve the locked row, not a client-side snapshot.
      catalog_settings = CASE WHEN item ? 'catalog_settings'
        THEN EXCLUDED.catalog_settings ELSE uw.catalog_settings END,
      updated_at = now()
    WHERE uw.owner_user_id = p_owner_user_id;
  END LOOP;

  UPDATE public.users SET rpdb_api_key = p_rpdb_api_key
  WHERE imdb_user_id = p_owner_user_id;

  SELECT coalesce(jsonb_agg(to_jsonb(uw) ORDER BY uw.position, uw.created_at), '[]'::jsonb)
  INTO watchlists FROM public.user_watchlists uw
  WHERE uw.owner_user_id = p_owner_user_id;
  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."replace_user_config"("p_owner_user_id" "text", "p_rpdb_api_key" "text", "p_watchlists" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid") RETURNS bigint
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  WITH request_time AS (
    SELECT clock_timestamp() AS requested_at
  ),
  requested AS (
    UPDATE public.users
    SET prewarm_request_generation = prewarm_request_generation + 1,
      prewarm_lease_token = CASE
        WHEN prewarm_locked_until <= request_time.requested_at
          THEN p_lease_token
        ELSE prewarm_lease_token
      END,
      prewarm_locked_until = CASE
        WHEN prewarm_locked_until <= request_time.requested_at
          THEN request_time.requested_at
            + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 1), 3600))
        ELSE prewarm_locked_until
      END
    FROM request_time
    WHERE imdb_user_id = p_owner_user_id
    RETURNING CASE
      WHEN prewarm_lease_token = p_lease_token
        THEN prewarm_request_generation
      ELSE NULL
    END AS claimed_generation
  )
  SELECT claimed_generation FROM requested;
$$;


ALTER FUNCTION "public"."request_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."user_watchlists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_user_id" "text" NOT NULL,
    "imdb_user_id" "text" NOT NULL,
    "catalog_title" "text" NOT NULL,
    "sort_option" "text" DEFAULT 'added_at-asc'::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "display_mode" "text" DEFAULT 'split'::"text" NOT NULL,
    "catalog_settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "user_watchlists_display_mode_check" CHECK (("display_mode" = ANY (ARRAY['split'::"text", 'movie'::"text", 'series'::"text"])))
);


ALTER TABLE "public"."user_watchlists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "imdb_user_id" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_cache_served_at" timestamp with time zone,
    "rpdb_api_key" "text",
    "prewarm_locked_until" timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone NOT NULL,
    "prewarm_lease_token" "uuid",
    "prewarm_request_generation" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."users" OWNER TO "postgres";


ALTER TABLE ONLY "public"."user_watchlists"
    ADD CONSTRAINT "user_watchlists_owner_user_id_imdb_user_id_key" UNIQUE ("owner_user_id", "imdb_user_id");



ALTER TABLE ONLY "public"."user_watchlists"
    ADD CONSTRAINT "user_watchlists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_imdb_user_id_key" UNIQUE ("imdb_user_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("imdb_user_id");



CREATE INDEX "idx_users_last_activity_at" ON "public"."users" USING "btree" ("last_fetched_at");



ALTER TABLE ONLY "public"."user_watchlists"
    ADD CONSTRAINT "user_watchlists_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("imdb_user_id") ON DELETE CASCADE;



ALTER TABLE "public"."user_watchlists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."finish_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid", "p_completed_generation" bigint) FROM PUBLIC;
-- pg_dump omits this: default privileges grant it on creation.
REVOKE ALL ON FUNCTION "public"."finish_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid", "p_completed_generation" bigint) FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."finish_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid", "p_completed_generation" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_user_config"("p_owner_user_id" "text", "p_rpdb_api_key" "text", "p_watchlists" "jsonb") FROM PUBLIC;
-- pg_dump omits this: default privileges grant it on creation.
REVOKE ALL ON FUNCTION "public"."replace_user_config"("p_owner_user_id" "text", "p_rpdb_api_key" "text", "p_watchlists" "jsonb") FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."replace_user_config"("p_owner_user_id" "text", "p_rpdb_api_key" "text", "p_watchlists" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid") FROM PUBLIC;
-- pg_dump omits this: default privileges grant it on creation.
REVOKE ALL ON FUNCTION "public"."request_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid") FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."request_watchlist_prewarm"("p_owner_user_id" "text", "p_lease_seconds" integer, "p_lease_token" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON TABLE "public"."user_watchlists" TO "anon";
GRANT ALL ON TABLE "public"."user_watchlists" TO "authenticated";
GRANT ALL ON TABLE "public"."user_watchlists" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


-- Supabase dashboard setting "enable RLS on new tables": every table created
-- in public gets row level security.
CREATE EVENT TRIGGER "ensure_rls" ON "ddl_command_end"
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION "public"."rls_auto_enable"();
