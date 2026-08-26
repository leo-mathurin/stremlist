import { createClient } from "@supabase/supabase-js";
import type { Database } from "@stremlist/shared";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../env.js";

// Service-role client: bypasses RLS, used only to reset and inspect state
// between tests. All functional seeding goes through the backend's own HTTP
// API so the tests exercise real code paths.
export const db = createClient<Database>(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

/** Delete test users. Foreign-key cascades reset every dependent table. */
export async function resetDb(): Promise<void> {
  const { error } = await db
    .from("users")
    .delete()
    .neq("imdb_user_id", "__e2e_no_matching_user__");
  if (error) throw new Error(`resetDb failed: ${error.message}`);
}

/** Rewind a user's last_fetched_at so the refresh cooldown does not apply. */
export async function clearRefreshCooldown(userId: string): Promise<void> {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { error } = await db
    .from("users")
    .update({ last_fetched_at: past })
    .eq("imdb_user_id", userId);
  if (error) throw new Error(`clearRefreshCooldown failed: ${error.message}`);
}

export async function countCacheItems(watchlistId: string): Promise<number> {
  const { count, error } = await db
    .from("watchlist_cache_items")
    .select("*", { count: "exact", head: true })
    .eq("watchlist_id", watchlistId);
  if (error) throw new Error(`countCacheItems failed: ${error.message}`);
  return count ?? 0;
}
