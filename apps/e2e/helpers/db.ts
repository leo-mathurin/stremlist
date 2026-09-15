import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@stremlist/shared/database.types";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../env.js";
import { E2E_USER_IDS } from "./test-data.js";
import { deleteCacheObjects } from "./r2.js";

// Service-role client: bypasses RLS, used only to reset and inspect state
// between tests. Live tests bootstrap through the HTTP API; controlled catalog
// fixtures seed rows before the backend first reads them.
const db = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Delete only this run's test users. Foreign-key cascades reset their data. */
export async function resetDb(): Promise<void> {
  const { data: watchlists, error: watchlistError } = await db
    .from("user_watchlists")
    .select("id")
    .in("owner_user_id", [...E2E_USER_IDS]);
  if (watchlistError) {
    throw new Error(
      `resetDb watchlist lookup failed: ${watchlistError.message}`,
    );
  }

  await deleteCacheObjects(watchlists.map((watchlist) => watchlist.id));

  const { error } = await db
    .from("users")
    .delete()
    .in("imdb_user_id", [...E2E_USER_IDS]);
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

/** Seed a fresh identity and row without warming the backend's memory cache. */
export async function seedWatchlist(
  userId: string,
  catalogTitle: string,
): Promise<string> {
  const user = await db.from("users").insert({ imdb_user_id: userId });
  if (user.error) throw user.error;
  const id = randomUUID();
  const watchlist = await db.from("user_watchlists").insert({
    id,
    owner_user_id: userId,
    imdb_user_id: userId,
    catalog_title: catalogTitle,
    sort_option: "added_at-asc",
    display_mode: "movie",
    position: 0,
  });
  if (watchlist.error) throw watchlist.error;
  return id;
}
