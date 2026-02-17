import type { Tables } from "@stremlist/shared";
import { supabase } from "../lib/supabase.js";

type User = Tables<"users">;

export async function getUser(imdbUserId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("imdb_user_id", imdbUserId)
    .single();

  if (error) {return null;}
  return data;
}

export async function ensureUser(imdbUserId: string): Promise<User> {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        imdb_user_id: imdbUserId,
        is_active: true,
        last_activity_at: new Date().toISOString(),
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
    console.error(`Failed to update sort option for ${imdbUserId}:`, error.message);
    throw error;
  }
}
