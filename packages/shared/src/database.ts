import type { Database as GeneratedDatabase } from "./database.types";

export type { Json, Tables } from "./database.types";

type GeneratedFunctions = GeneratedDatabase["public"]["Functions"];

// Postgres function parameters cannot be declared NOT NULL, so
// `supabase gen types` types every argument as non-null. These arguments take
// SQL NULL on purpose: it clears the column or keeps the current value. Keep
// this list in step with the SQL functions instead of editing the generated
// file, which CI regenerates from the migrations.
type NullableArgs = {
  create_account_with_config: "p_new_titles_catalog" | "p_rpdb_api_key";
  letterboxd_take_turn: "p_ticket";
  record_list_refresh: "p_failure_reason" | "p_title_count";
  replace_account_config:
    | "p_action_providers"
    | "p_actions_enabled"
    | "p_new_titles_catalog"
    | "p_rpdb_api_key";
  save_connection:
    | "p_expires_at"
    | "p_provider_username"
    | "p_refresh_token"
    | "p_scope";
};

type WithNullable<Args, Keys extends keyof Args> = {
  [Key in keyof Args]: Key extends Keys ? Args[Key] | null : Args[Key];
};

type Functions = {
  [Name in keyof GeneratedFunctions]: Name extends keyof NullableArgs
    ? Omit<GeneratedFunctions[Name], "Args"> & {
        Args: WithNullable<
          GeneratedFunctions[Name]["Args"],
          NullableArgs[Name] & keyof GeneratedFunctions[Name]["Args"]
        >;
      }
    : GeneratedFunctions[Name];
};

// The schema that the Supabase clients use. Import it instead of the
// generated `database.types`.
export type Database = Omit<GeneratedDatabase, "public"> & {
  // `supabase gen types --local` does not report the server version. This is
  // the PostgREST version of the production project, which unlocks the
  // PostgREST 13+ query types in supabase-js.
  __InternalSupabase: { PostgrestVersion: "14.1" };
  public: Omit<GeneratedDatabase["public"], "Functions"> & {
    Functions: Functions;
  };
};
