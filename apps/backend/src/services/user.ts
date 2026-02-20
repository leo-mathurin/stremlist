import type { Tables } from "@stremlist/shared";
import { supabase } from "../lib/supabase";

type User = Tables<"users">;

export async function getUser(imdbUserId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {
    return null;
  }
  return data;
}

export async function ensureUser(imdbUserId: string): Promise<User> {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        imdb_user_id: imdbUserId,
        is_active: true,
        last_fetched_at: new Date().toISOString(),
      },
      { onConflict: "imdb_user_id" },
    )
    .select("*")
    .single();

  if (error) {
    console.error(`Failed to upsert user ${imdbUserId}:`, error.message);
    throw error;
  }

  return data;
}

export async function getUserSortOption(
  imdbUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("sort_option")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {
    return null;
  }

  return data.sort_option;
}

export async function setUserSortOption(
  imdbUserId: string,
  sortOption: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ sort_option: sortOption })
    .eq("imdb_user_id", imdbUserId);

  if (error) {
    console.error(
      `Failed to update sort option for ${imdbUserId}:`,
      error.message,
    );
    throw error;
  }
}

export async function getUserRpdbApiKey(
  imdbUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("rpdb_api_key")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return data.rpdb_api_key;
}

export async function setUserRpdbApiKey(
  imdbUserId: string,
  rpdbApiKey: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ rpdb_api_key: rpdbApiKey })
    .eq("imdb_user_id", imdbUserId);

  if (error) {
    console.error(
      `Failed to update RPDB API key for ${imdbUserId}:`,
      error.message,
    );
    throw error;
  }
}
