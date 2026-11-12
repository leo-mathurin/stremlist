/**
 * What a member's Stremio app tells Stremlist (ADR 0003):
 *
 * - a `/stream` request, sent before every play: read the item at once and
 *   start its read cycle;
 * - a Stremio Web `pause` or `stop` player event: read it at the next run;
 * - a Stremio Web `library` event for a manual mark: read it at once.
 */
import { isProviderId } from "@stremlist/shared/providers";
import { decryptSecret } from "../../lib/crypto";
import { LruCache } from "../../lib/lru";
import { supabase } from "../../lib/supabase";
import { recordItems } from "./detect";
import { isEpisodeWatched, movieWatched } from "./library";
import { readLibraryItems } from "./pace";
import { newCycle, planAfterRead } from "./schedule";
import { linkOf } from "./state";
import { destinationsNow } from "./sweep";

interface WatchContext {
  authKey: string;
  hasBaseline: boolean;
}

/** Most /stream requests come from Accounts that are not tracked. */
const contexts = new LruCache<string, WatchContext | null>({
  maxEntries: 5000,
  ttlMs: 60_000,
});

/** The Stremio key of a tracked Account, or null. */
async function watchContext(accountId: string): Promise<WatchContext | null> {
  const cached = contexts.get(accountId);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("watch_context", {
    p_account_id: accountId,
  });
  if (error) throw error;
  const row = data.at(0);
  const context = row
    ? {
        authKey: row.auth_key,
        hasBaseline: (row.baseline_at as string | null) !== null,
      }
    : null;
  contexts.set(accountId, context);
  return context;
}

/** Forget the cached context after a change of the Account's tracking. */
export function forgetWatchContext(accountId: string): void {
  contexts.delete(accountId);
}

async function isTracked(accountId: string): Promise<boolean> {
  return (await watchContext(accountId)) !== null;
}

/**
 * A /stream request of a tracked Account: read the item, then start its
 * cycle. A title that Stremio already shows as watched has no cycle: a
 * replay is never sent.
 */
export async function onStreamRequest(
  accountId: string,
  type: "movie" | "series",
  videoId: string,
): Promise<void> {
  const context = await watchContext(accountId);
  if (!context) return;
  const itemId = videoId.split(":")[0];
  const [item] = await readLibraryItems(decryptSecret(context.authKey), [
    itemId,
  ]);
  const watched =
    type === "movie"
      ? movieWatched(item)
      : await isEpisodeWatched(item, videoId);
  if (watched) return;
  const now = Date.now();
  const row = newCycle(type, videoId, item, now);
  // A resume shows the play at once; a new play shows it after it starts.
  const plan = planAfterRead(row, item, false, now);
  // Unset arguments are null in the database.
  const iso = (value: number | null) =>
    value === null ? undefined : new Date(value).toISOString();
  const { error } = await supabase.rpc("watch_restart", {
    p_account_id: accountId,
    p_item_id: itemId,
    p_item_type: type,
    p_video_id: videoId,
    p_due_at: new Date(plan.next ?? now + 120_000).toISOString(),
    p_phase: plan.row.phase,
    p_start_state: { ...row.startState },
    p_last_time_watched: plan.row.lastTimeWatched ?? undefined,
    p_expected_flip_at: iso(plan.row.expectedFlipAt),
    p_expected_end_at: iso(plan.row.expectedEndAt),
  });
  if (error) throw error;
}

/** A `pause` or `stop` of Stremio Web: read the item at the next run. */
export async function onPlayerEvent(
  accountId: string,
  videoId: string,
): Promise<void> {
  if (!(await isTracked(accountId))) return;
  const { error } = await supabase.rpc("watch_read_soon", {
    p_account_id: accountId,
    p_item_id: videoId.split(":")[0],
  });
  if (error) throw error;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The event and the cloud write leave the app at the same moment. */
const EVENT_SETTLE_MS = 3000;

/**
 * A manual mark in Stremio Web: read the item a few seconds later and send
 * what is new against the Account's watch state.
 */
export async function onLibraryWatchedEvent(
  accountId: string,
  itemId: string,
): Promise<void> {
  const context = await watchContext(accountId);
  if (!context?.hasBaseline) return;
  await sleep(EVENT_SETTLE_MS);
  const item = (
    await readLibraryItems(decryptSecret(context.authKey), [itemId])
  ).at(0);
  if (!item) return;
  const { data, error } = await supabase.rpc("watch_active_destinations", {
    p_account_id: accountId,
  });
  if (error) throw error;
  const destinations = await destinationsNow(
    accountId,
    decryptSecret(context.authKey),
    data.filter(isProviderId),
  );
  await recordItems(accountId, destinations, [item], {
    link: linkOf(context.authKey),
  });
}
